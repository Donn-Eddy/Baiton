import * as assert from 'assert';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for the Copilot orchestrator model client (Requirement 7).
 *
 * `CopilotModelClient` takes its `vscode` surface injected, so this suite hands
 * it the shared fake module loaded through `fixtures/vscodeLoader.mjs`. The
 * loader hook is registered in `before()` exactly as `test/setApiKey.test.ts`
 * does: build the loader URL from `process.cwd()`, `register(loaderUrl,
 * pathToFileURL(join(root, '/')).href)`, then import the loader. The fake
 * module itself is imported directly and cast to `CopilotVscodeApi` — it has
 * no runtime dependency on the hook (the hook redirects bare `vscode` imports,
 * which this module never makes).
 *
 * Per-test behavior lives in the mutable fake installed on
 * `globalThis.__vscodeFake` (the model list for `lm.selectChatModels`) and in
 * the `FakeChat` models each test seeds into that list. `CancellationTokenSource`
 * instances produced by the client are observed by swapping a recording
 * subclass into the injected api object.
 */

import {
  COPILOT_JUSTIFICATION,
  COPILOT_VENDOR,
  CopilotModelClient,
  CopilotVscodeApi,
  mapCopilotError,
  parseCopilotToolInput,
  selectCopilotModel,
  toCopilotMessages,
  toCopilotTools,
} from '../src/orchestrator/copilotClient';
import {
  ChatMessage,
  CompletionRequest,
  MissingConfigError,
  ModelClient,
  ToolCall,
  ToolSpec,
  UnreachableEndpointError,
} from '../src/orchestrator/modelClient';

type LanguageModelChatLike = import('vscode').LanguageModelChat;

describe('Copilot orchestrator model client', () => {
  /** The fake module, loaded through the vscode loader hook in `before()`. */
  let fakeMod: typeof import('./fixtures/vscodeFake.mjs');
  /** The same module cast to the surface the client expects. */
  let api: CopilotVscodeApi;
  /** The api object handed to the client this test, with recording CTS swaps. */
  let clientApi: CopilotVscodeApi;

  let selectorCalls: Array<{ vendor: string }>;
  let sendRequestCalls: Array<{
    messages: Array<{ role: number; content: Array<Record<string, unknown>> }>;
    options?: { justification?: string; tools?: unknown[] };
    token?: { isCancellationRequested: boolean };
  }>;
  /** Every CancellationTokenSource the client created for the current test. */
  let sources: Array<typeof import('./fixtures/vscodeFake.mjs')['CancellationTokenSource']>;

  /** A recorded stream layout the `FakeChat` replays. */
  interface StreamPlan {
    /** Parts yielded in order. */
    parts: unknown[];
    /** Thrown instead of finishing the stream. */
    rejectWith?: unknown;
    /** Thrown between two parts. */
    throwMidStream?: unknown;
    /** Invoked right before a throw-mid-stream (used to trigger the abort). */
    onIterate?: () => void;
  }

  /** The fake `LanguageModelChat` a test installs as the only model. */
  class FakeChat implements LanguageModelChatLike {
    public readonly vendor = 'copilot' as const;
    public readonly version = '1.0.0';
    public readonly maxInputTokens = 100_000;
    private readonly plan: StreamPlan;
    public readonly id: string;
    public readonly family: string;
    public readonly name: string;

    constructor(plan: StreamPlan = { parts: [] }, id?: string, family?: string, name = 'Fake Copilot Model') {
      this.plan = plan;
      this.id = id ?? 'fake-model';
      this.family = family ?? 'fake-fam';
      this.name = name;
    }

    public async countTokens(): Promise<number> {
      return 0;
    }

    public async sendRequest(
      messages: import('vscode').LanguageModelChatMessage[],
      options?: import('vscode').LanguageModelChatRequestOptions,
      token?: import('vscode').CancellationToken,
    ): Promise<import('vscode').LanguageModelChatResponse> {
      assert.ok(Array.isArray(messages));
      sendRequestCalls.push({ messages, options, token } as never);
      const plan = this.plan;
      if (plan.rejectWith !== undefined) {
        // Thrown before the stream starts.
        throw plan.rejectWith;
      }
      async function* stream(): AsyncGenerator<unknown> {
        for (let i = 0; i < plan.parts.length; i++) {
          yield plan.parts[i];
          if (i === 0 && plan.throwMidStream !== undefined) {
            plan.onIterate?.();
            throw plan.throwMidStream;
          }
        }
      }
      return {
        stream: stream(),
      } as unknown as import('vscode').LanguageModelChatResponse;
    }
  }

  /** Installs the globalThis fake with the given models and recording CTS. */
  function install(modelList: FakeChat[]): void {
    selectorCalls = [];
    sendRequestCalls = [];
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = {
      lm: {
        selectChatModels: async (selector: { vendor: string }) => {
          selectorCalls.push(selector);
          return modelList;
        },
      },
    };
    const fakeCts = fakeMod.CancellationTokenSource;
    sources = [];
    class Recording extends fakeCts {
      constructor() {
        super();
        (sources as unknown as { disposed: boolean }[]).push(
          this as unknown as { disposed: boolean },
        );
      }
    }
    clientApi = {
      ...(api as unknown as Record<string, unknown>),
      CancellationTokenSource: Recording,
    } as unknown as CopilotVscodeApi;
  }

  /** A completion request over a live AbortController. */
  function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
    return {
      messages: [],
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  before(async () => {
    // Register the hook that redirects `vscode` to the in-repo fake, then
    // import the loader so the hook is active (same as test/setApiKey.test.ts).
    const root = process.cwd();
    const loaderUrl = pathToFileURL(join(root, 'test', 'fixtures', 'vscodeLoader.mjs')).href;
    register(loaderUrl, pathToFileURL(join(root, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    fakeMod = await import('./fixtures/vscodeFake.mjs');
    api = fakeMod as unknown as CopilotVscodeApi;
  });

  beforeEach(() => {
    sources = [];
    selectorCalls = [];
    sendRequestCalls = [];
    // Installing the fake is per-test; `install()` does it.
  });

  describe('toCopilotMessages (message mapping)', () => {
    it('maps system and user messages to User messages', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ];
      const mapped = toCopilotMessages(messages, api);
      assert.strictEqual(mapped.length, 2);
      for (const m of mapped) {
        assert.strictEqual(m.role, fakeMod.LanguageModelChatMessageRole.User);
      }
      assert.strictEqual((mapped[0].content[0] as { value: string }).value, 'be terse');
      assert.strictEqual((mapped[1].content[0] as { value: string }).value, 'hello');
    });

    it('maps a plain assistant message to an Assistant message', () => {
      const mapped = toCopilotMessages(
        [{ role: 'assistant', content: 'all done' }],
        api,
      );
      assert.strictEqual(mapped.length, 1);
      assert.strictEqual(mapped[0].role, fakeMod.LanguageModelChatMessageRole.Assistant);
      assert.strictEqual((mapped[0].content[0] as { value: string }).value, 'all done');
    });

    it('maps an assistant turn with tool calls into ToolCallParts first, then text', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [
            { id: 'c1', name: 'readFile', arguments: '{"path":"a.ts"}' },
            { id: 'c2', name: 'listDir', arguments: '{}' },
          ] as ToolCall[],
        },
      ];
      const mapped = toCopilotMessages(messages, api);
      assert.strictEqual(mapped.length, 1);
      assert.strictEqual(mapped[0].role, fakeMod.LanguageModelChatMessageRole.Assistant);
      const parts = mapped[0].content as unknown as Array<Record<string, unknown>>;
      assert.strictEqual(parts.length, 2);
      assert.deepStrictEqual(
        parts.map((p) => ({ callId: p.callId, name: p.name })),
        [
          { callId: 'c1', name: 'readFile' },
          { callId: 'c2', name: 'listDir' },
        ],
      );
      assert.deepStrictEqual(parts[0].input, { path: 'a.ts' });
      assert.deepStrictEqual(parts[1].input, {});
    });

    it('puts assistant text before the tool-call parts when both are present', () => {
      const mapped = toCopilotMessages(
        [
          {
            role: 'assistant',
            content: 'let me look',
            tool_calls: [{ id: 'c1', name: 'readFile', arguments: '{}' }],
          },
        ],
        api,
      );
      const parts = mapped[0].content as unknown as Array<Record<string, unknown>>;
      assert.strictEqual(parts.length, 2);
      assert.strictEqual((parts[0] as { value: string }).value, 'let me look');
      assert.strictEqual((parts[1] as { callId: string }).callId, 'c1');
    });

    it('collapses a run of consecutive tool messages into ONE User message in order', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 't1', arguments: '{}' }, { id: 'c2', name: 't2', arguments: '{}' }] },
        { role: 'tool', content: 'result one', tool_call_id: 'c1' },
        { role: 'tool', content: 'result two', tool_call_id: 'c2' },
      ];
      const mapped = toCopilotMessages(messages, api);
      assert.strictEqual(mapped.length, 2, 'assistant, then one collapsed User message');
      const last = mapped[1];
      assert.strictEqual(last.role, fakeMod.LanguageModelChatMessageRole.User);
      const parts = last.content as unknown as Array<Record<string, unknown>>;
      assert.strictEqual(parts.length, 2);
      assert.strictEqual(parts[0].callId, 'c1');
      assert.strictEqual(parts[1].callId, 'c2');
      assert.deepStrictEqual(
        (parts[0].content as Array<{ value: string }>)[0].value,
        'result one',
      );
      assert.deepStrictEqual(
        (parts[1].content as Array<{ value: string }>)[0].value,
        'result two',
      );
    });

    it('drops a tool message without a tool_call_id', () => {
      const mapped = toCopilotMessages(
        [{ role: 'tool', content: 'orphan' } as ChatMessage],
        api,
      );
      assert.deepStrictEqual(mapped, []);
    });

    it('drops empty non-tool messages instead of sending zero-part messages', () => {
      const mapped = toCopilotMessages(
        [{ role: 'user', content: '   ' }, { role: 'assistant', content: '' }],
        api,
      );
      assert.deepStrictEqual(mapped, []);
    });

    it('never mutates the input transcript', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 's' },
        { role: 'assistant', content: 'a', tool_calls: [{ id: 'c', name: 't', arguments: '{}' }] },
        { role: 'tool', content: 'r', tool_call_id: 'c' },
      ];
      const clone: ChatMessage[] = JSON.parse(JSON.stringify(messages));
      toCopilotMessages(messages, api);
      assert.deepStrictEqual(messages, clone);
    });

    it('end-to-end: the transcript reaches sendRequest through the mapper', async () => {
      const chat = new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] });
      install([chat]);
      const client = new CopilotModelClient({
        api: clientApi,
        getModel: async () => 'fake-model',
      });
      await client.complete(
        req({
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
          ],
        }),
      );
      const sent = sendRequestCalls[0].messages;
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[0].role, fakeMod.LanguageModelChatMessageRole.User);
      assert.strictEqual(sent[1].role, fakeMod.LanguageModelChatMessageRole.User);
      assert.strictEqual(
        (sent[1].content[0] as { value: string }).value,
        'u',
      );
    });
  });

  describe('parseCopilotToolInput', () => {
    it('keeps a parsed non-null non-array JSON object', () => {
      assert.deepStrictEqual(parseCopilotToolInput('{"a":1}'), { a: 1 });
    });

    it('falls back to {} for arrays and scalars', () => {
      assert.deepStrictEqual(parseCopilotToolInput('[]'), {});
      assert.deepStrictEqual(parseCopilotToolInput('"x"'), {});
      assert.deepStrictEqual(parseCopilotToolInput('null'), {});
      assert.deepStrictEqual(parseCopilotToolInput(''), {});
    });

    it('falls back to {} for malformed JSON instead of throwing', () => {
      assert.deepStrictEqual(parseCopilotToolInput('{broken'), {});
    });
  });

  describe('tool mapping and request options', () => {
    const tools: ToolSpec[] = [
      { name: 'readFile', description: 'Read a file.', parameters: { type: 'object' } },
    ];

    it('shapes ToolSpecs into LanguageModelChatTools', () => {
      assert.deepStrictEqual(toCopilotTools(tools), [
        { name: 'readFile', description: 'Read a file.', inputSchema: { type: 'object' } },
      ]);
    });

    it('sends options.tools end-to-end when tools are provided', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await client.complete(req({ tools }));
      assert.deepStrictEqual(sendRequestCalls[0].options?.tools, [
        { name: 'readFile', description: 'Read a file.', inputSchema: { type: 'object' } },
      ]);
    });

    it('omits options.tools entirely when the request carries none', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await client.complete(req({ tools: undefined }));
      assert.ok(!('tools' in (sendRequestCalls[0].options ?? {})));

      await client.complete(req({ tools: [] }));
      assert.ok(!('tools' in (sendRequestCalls[1].options ?? {})));
    });

    it('sends a non-empty justification, overridable through config', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const defaults = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await defaults.complete(req());
      assert.strictEqual(sendRequestCalls[0].options?.justification, COPILOT_JUSTIFICATION);
      assert.ok(COPILOT_JUSTIFICATION.length > 0);

      const custom = new CopilotModelClient({
        api: clientApi,
        getModel: async () => 'fake-model',
        justification: 'my reason',
      });
      await custom.complete(req());
      assert.strictEqual(sendRequestCalls[1].options?.justification, 'my reason');
    });
  });

  describe('streaming text', () => {
    it('streams each non-empty text part to onDelta in order and concatenates', async () => {
      install([
        new FakeChat({
          parts: [
            new fakeMod.LanguageModelTextPart('he'),
            new fakeMod.LanguageModelTextPart(''),
            new fakeMod.LanguageModelTextPart('llo'),
          ],
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      const deltas: string[] = [];
      const result = await client.complete(req({ messages: [], onDelta: (d) => deltas.push(d) }));
      assert.deepStrictEqual(deltas, ['he', 'llo']);
      assert.strictEqual(result.content, 'hello');
      assert.deepStrictEqual(result.tool_calls, []);
    });

    it('returns content undefined when the stream emitted no text part', async () => {
      install([
        new FakeChat({
          parts: [new fakeMod.LanguageModelToolCallPart('c1', 't1', {})],
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      const result = await client.complete(req());
      assert.strictEqual(result.content, undefined);
      assert.deepStrictEqual(result.tool_calls, [{ id: 'c1', name: 't1', arguments: '{}' }]);
    });
  });

  describe('tool-call collection', () => {
    it('collects tool-call parts in stream order with JSON-string arguments', async () => {
      install([
        new FakeChat({
          parts: [
            new fakeMod.LanguageModelToolCallPart('c1', 't1', { a: 1 }),
            new fakeMod.LanguageModelToolCallPart('c2', 't2', {}),
          ],
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      const result = await client.complete(req());
      assert.deepStrictEqual(result.content, undefined);
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'c1', name: 't1', arguments: '{"a":1}' },
        { id: 'c2', name: 't2', arguments: '{}' },
      ]);
    });

    it('ignores a part that is neither a text part nor a tool-call part', async () => {
      install([
        new FakeChat({
          parts: [{ someFuturePart: true }, new fakeMod.LanguageModelTextPart('x')],
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      const result: { content?: string; tool_calls: ToolCall[] } = await client.complete(req());
      assert.strictEqual(result.content, 'x');
      assert.deepStrictEqual(result.tool_calls, []);
    });

    it('counts a part carrying both text and a tool call only once (text wins)', async () => {
      install([
        new FakeChat({
          parts: [Object.assign(new fakeMod.LanguageModelTextPart('t'), { callId: 'c', name: 'n' })],
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      const result = await client.complete(req());
      assert.strictEqual(result.content, 't');
      assert.deepStrictEqual(result.tool_calls, []);
    });
  });

  describe('model resolution', () => {
    it('selectChatModels is called once with exactly `{ vendor: copilot }`', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await client.complete(req());
      assert.strictEqual(selectorCalls.length, 1);
      assert.deepStrictEqual(selectorCalls[0], { vendor: COPILOT_VENDOR });
      assert.deepStrictEqual(selectorCalls[0], { vendor: 'copilot' });
    });

    it('resolves the model by id and, failing that, by family', async () => {
      const byId = new FakeChat({ parts: [] }, 'target-id');
      install([byId]);
      assert.strictEqual(await selectCopilotModel(clientApi, 'target-id'), byId);
      const byFamily = new FakeChat({ parts: [] }, 'other-id', 'target-fam');
      install([byFamily]);
      assert.strictEqual(await selectCopilotModel(clientApi, 'target-fam'), byFamily);
    });

    it('an empty model list means MissingConfigError(model) with no sendRequest', async () => {
      install([]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'gone' });
      await assert.rejects(client.complete(req()), (err) => {
        assert.ok(err instanceof MissingConfigError);
        assert.strictEqual((err as MissingConfigError).missing, 'model');
        return true;
      });
      assert.strictEqual(sendRequestCalls.length, 0);
    });

    it('a getModel resolving to undefined fails before touching the host', async () => {
      install([new FakeChat({ parts: [] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => undefined });
      await assert.rejects(client.complete(req()), MissingConfigError);
      assert.strictEqual(selectorCalls.length, 0);
      assert.strictEqual(sendRequestCalls.length, 0);
    });
  });

  describe('abort handling', () => {
    it('a pre-aborted signal rejects before any host call', async () => {
      install([new FakeChat({ parts: [] })]);
      const controller = new AbortController();
      controller.abort();
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(
        client.complete(req({ signal: controller.signal })),
        UnreachableEndpointError,
      );
      assert.strictEqual(selectorCalls.length, 0);
      assert.strictEqual(sendRequestCalls.length, 0);
    });

    it('an abort mid-stream cancels the token and rejects UnreachableEndpointError', async () => {
      const controller = new AbortController();
      const chat = new FakeChat({
        parts: [new fakeMod.LanguageModelTextPart('first')],
        throwMidStream: new Error('cancelled'),
        onIterate: () => controller.abort(),
      });
      install([chat]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(
        client.complete(req({ messages: [], signal: controller.signal })),
        UnreachableEndpointError,
      );
      assert.strictEqual(sendRequestCalls.length, 1);
      assert.strictEqual(sendRequestCalls[0].token?.isCancellationRequested, true);
      assert.strictEqual((sources[0] as unknown as { disposed: boolean }).disposed, true);
    });

    it('the token source is disposed on the success path too', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await client.complete(req());
      assert.strictEqual((sources[0] as unknown as { disposed: boolean }).disposed, true);
    });
  });

  describe('error mapping', () => {
    it('NotFound from sendRequest maps to MissingConfigError(model)', async () => {
      install([new FakeChat({ parts: [], rejectWith: fakeMod.LanguageModelError.NotFound('gone') })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(client.complete(req()), (err) => {
        assert.ok(err instanceof MissingConfigError);
        assert.strictEqual((err as MissingConfigError).missing, 'model');
        return true;
      });
    });

    it('NoPermissions and Blocked map to UnreachableEndpointError', async () => {
      install([new FakeChat({ parts: [], rejectWith: fakeMod.LanguageModelError.NoPermissions('denied') })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(client.complete(req()), UnreachableEndpointError);

      install([new FakeChat({ parts: [], rejectWith: fakeMod.LanguageModelError.Blocked('quota') })]);
      const client2 = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(client2.complete(req()), UnreachableEndpointError);
    });

    it('a plain error maps to UnreachableEndpointError carrying it as cause', async () => {
      install([new FakeChat({ parts: [], rejectWith: new Error('boom') })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(client.complete(req()), (err) => {
        assert.ok(err instanceof UnreachableEndpointError);
        assert.strictEqual((err as { cause?: unknown }).cause instanceof Error, true);
        return true;
      });
    });

    it('mapCopilotError never re-wraps our own errors', () => {
      const missing = new MissingConfigError('model');
      const unreachable = new UnreachableEndpointError('down');
      assert.strictEqual(
        mapCopilotError(missing as unknown),
        missing as unknown as Error,
      );
      assert.strictEqual(mapCopilotError(unreachable), unreachable);
    });

    it('a mid-stream throw maps to UnreachableEndpointError', async () => {
      install([
        new FakeChat({
          parts: [new fakeMod.LanguageModelTextPart('partial')],
          throwMidStream: fakeMod.LanguageModelError.Blocked('quota'),
        }),
      ]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await assert.rejects(client.complete(req()), UnreachableEndpointError);
    });
  });

  describe('session id', () => {
    it('is not forwarded into the request options', async () => {
      install([new FakeChat({ parts: [new fakeMod.LanguageModelTextPart('hi')] })]);
      const client = new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model' });
      await client.complete(req({ sessionId: 'sess-123', tools: [] as ToolSpec[] }));
      const options = sendRequestCalls[0].options ?? {};
      assert.deepStrictEqual(Object.keys(options), ['justification']);
    });
  });

  describe('ModelClient conformance', () => {
    it('is a ModelClient', () => {
      const client = new CopilotModelClient({
        api: clientApi,
        getModel: async () => 'fake-model',
      });
      const asInterface: ModelClient = client;
      assert.ok(typeof asInterface.complete === 'function');
    });
  });

  describe('mapCopilotError (direct)', () => {
    it('keeps the cause on generic failures', () => {
      const original = new Error('boom');
      const mapped = mapCopilotError(original);
      assert.ok(mapped instanceof UnreachableEndpointError);
      assert.strictEqual((mapped as { cause?: unknown }).cause, original);
    });
  });
});
