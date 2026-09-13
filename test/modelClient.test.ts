import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  OpenAiModelClient,
  MissingConfigError,
  UnreachableEndpointError,
  ModelClientConfig,
  ChatMessage,
  ToolSpec,
  completionsUrl,
  resolveMaxTokens,
  SseCompletionParser,
} from '../src/orchestrator/modelClient';

/**
 * Unit tests for the OpenAI-compatible model client against a local mock HTTP
 * server (Task 12.2). These cover the behaviors the design pins down for the
 * orchestrator model client:
 *
 * - non-streaming path parses `tool_calls` and assistant content (Req 7.1, 7.2)
 * - streaming path (SSE `data:` frames) accumulates content and tool-call
 *   argument deltas by index (Req 7.2)
 * - missing endpoint/model/key each abort with a {@link MissingConfigError}
 *   naming the missing value, before any request is issued (Req 7.5)
 * - a connection/timeout failure maps to {@link UnreachableEndpointError}
 *   (Req 7.6)
 * - `tools` are sent on the wire and the returned `tool_calls` round-trip
 *   (Req 7.1)
 *
 * A single mock server is stood up per test (or reused within a describe) and
 * torn down afterwards so no port leaks.
 */

/** A record of one request the mock server received, body already parsed. */
interface CapturedRequest {
  authorization: string | undefined;
  body: unknown;
}

/** A running mock server plus its base URL and the last captured request. */
interface MockServer {
  url: string;
  captured: CapturedRequest[];
  close(): Promise<void>;
}

/**
 * Stand up a local HTTP server that reads the JSON request body, records it,
 * and replies with `responder`'s status/body. Resolves once it is listening.
 */
async function startMockServer(
  responder: (body: unknown) => { status?: number; headers?: http.OutgoingHttpHeaders; body: string },
): Promise<MockServer> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      captured.push({ authorization: req.headers.authorization, body: parsed });
      const { status = 200, headers = { 'content-type': 'application/json' }, body } = responder(parsed);
      res.writeHead(status, headers);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Build a client config from an explicit endpoint plus optional overrides. */
function makeConfig(
  endpoint: string | undefined,
  overrides: Partial<ModelClientConfig> = {},
): ModelClientConfig {
  return {
    getEndpoint: () => endpoint,
    getModel: () => 'test-model',
    getApiKey: () => 'test-key',
    ...overrides,
  };
}

/** A fresh, non-aborted signal for the happy-path requests. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

const SAMPLE_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const SAMPLE_TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

describe('OpenAiModelClient', () => {
  describe('non-streaming branch', () => {
    let mock: MockServer;
    afterEach(async () => {
      await mock.close();
    });

    it('parses assistant content and tool_calls from a non-streaming response', async () => {
      mock = await startMockServer(() => ({
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: 'here you go',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
        }),
      }));

      const client = new OpenAiModelClient(makeConfig(mock.url, { isStreaming: () => false }));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      assert.strictEqual(result.content, 'here you go');
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ]);
    });

    it('sends stream:false and hits the /v1/chat/completions path', async () => {
      let path: string | undefined;
      const server = http.createServer((req, res) => {
        path = req.url;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };
          assert.strictEqual(parsed.stream, false);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      mock = {
        url: `http://127.0.0.1:${port}`,
        captured: [],
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
      };

      const client = new OpenAiModelClient(makeConfig(mock.url));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      assert.strictEqual(path, '/v1/chat/completions');
      assert.strictEqual(result.content, 'ok');
      assert.deepStrictEqual(result.tool_calls, []);
    });
  });

  describe('max_tokens', () => {
    let mock: MockServer;
    afterEach(async () => {
      await mock.close();
    });

    const respond = () => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) });

    const run = async (getMaxTokens: () => unknown): Promise<{ max_tokens?: number }> => {
      mock = await startMockServer(respond);
      const client = new OpenAiModelClient(makeConfig(mock.url, { getMaxTokens }));
      await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });
      return mock.captured[0].body as { max_tokens?: number };
    };

    it('sends max_tokens when the configured value is a positive integer', async () => {
      assert.strictEqual((await run(() => 512)).max_tokens, 512);
    });

    it('omits max_tokens when the configured value is 0 (off)', async () => {
      assert.ok(!('max_tokens' in (await run(() => 0))));
    });

    it('omits max_tokens when the setting is unset', async () => {
      mock = await startMockServer(respond);
      const client = new OpenAiModelClient(makeConfig(mock.url));
      await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });
      assert.ok(!('max_tokens' in (mock.captured[0].body as object)));
    });

  });

  describe('resolveMaxTokens', () => {
    it('accepts positive integers and rejects everything else', () => {
      assert.strictEqual(resolveMaxTokens(1), 1);
      assert.strictEqual(resolveMaxTokens(4096), 4096);
      assert.strictEqual(resolveMaxTokens(0), undefined);
      assert.strictEqual(resolveMaxTokens(-5), undefined);
      assert.strictEqual(resolveMaxTokens(1.5), undefined);
      assert.strictEqual(resolveMaxTokens('512'), undefined);
      assert.strictEqual(resolveMaxTokens(undefined), undefined);
    });
  });

  describe('completionsUrl', () => {
    it('uses a full chat-completions URL verbatim', () => {
      assert.strictEqual(
        completionsUrl('https://api.deepinfra.com/v1/openai/chat/completions').href,
        'https://api.deepinfra.com/v1/openai/chat/completions',
      );
    });

    it('appends /v1/chat/completions to a bare origin', () => {
      assert.strictEqual(
        completionsUrl('http://localhost:11434/').href,
        'http://localhost:11434/v1/chat/completions',
      );
    });

    it('appends /chat/completions to a provider base path', () => {
      assert.strictEqual(
        completionsUrl('https://api.openai.com/v1').href,
        'https://api.openai.com/v1/chat/completions',
      );
      assert.strictEqual(
        completionsUrl('https://api.deepinfra.com/v1/openai/').href,
        'https://api.deepinfra.com/v1/openai/chat/completions',
      );
      assert.strictEqual(
        completionsUrl('https://open.bigmodel.cn/api/paas/v4').href,
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      );
    });
  });

  describe('assistant tool_calls on the wire', () => {
    let mock: MockServer;
    afterEach(async () => {
      await mock.close();
    });

    it('sends recorded assistant tool calls in OpenAI function shape', async () => {
      mock = await startMockServer(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }));
      const client = new OpenAiModelClient(makeConfig(mock.url));
      await client.complete({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }],
          },
          { role: 'tool', content: 'data', tool_call_id: 'call_1' },
        ],
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });
      const sent = mock.captured[0].body as { messages: Array<Record<string, unknown>> };
      assert.deepStrictEqual(sent.messages[1], {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ],
      });
      assert.strictEqual('tool_calls' in sent.messages[0], false);
    });
  });

  describe('streaming branch', () => {
    let mock: MockServer;
    afterEach(async () => {
      await mock.close();
    });

    it('accumulates content and tool-call argument deltas across SSE frames', async () => {
      const frames = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file' } }] } }],
          }),
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }],
          }),
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.txt"}' } }] } }],
          }),
        'data: [DONE]',
        '',
      ].join('\n\n');

      mock = await startMockServer(() => ({
        headers: { 'content-type': 'text/event-stream' },
        body: frames,
      }));

      const client = new OpenAiModelClient(makeConfig(mock.url, { isStreaming: () => true }));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      assert.strictEqual(result.content, 'Hello');
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_9', name: 'read_file', arguments: '{"path":"b.txt"}' },
      ]);
    });

    it('keeps a streamed tool call whose later frames carry null id and name', async () => {
      // Reproduces a real server that repeats the tool-call envelope on every
      // argument fragment with `"id": null` / `"name": null`; the finalized call
      // must keep the id and name from the first frame (Req 7.2).
      const frames = [
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'call_7', function: { name: 'glob', arguments: '' } }] } },
            ],
          }),
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"glob":' } }] } },
            ],
          }),
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"**/*"}' } }] } },
            ],
          }),
        'data: [DONE]',
        '',
      ].join('\n\n');

      mock = await startMockServer(() => ({
        headers: { 'content-type': 'text/event-stream' },
        body: frames,
      }));

      const client = new OpenAiModelClient(makeConfig(mock.url, { isStreaming: () => true }));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_7', name: 'glob', arguments: '{"glob":"**/*"}' },
      ]);
    });

    it('sends stream:true when the endpoint advertises streaming', async () => {
      mock = await startMockServer((body) => {
        assert.strictEqual((body as { stream?: boolean }).stream, true);
        return {
          headers: { 'content-type': 'text/event-stream' },
          body: ['data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]', ''].join(
            '\n\n',
          ),
        };
      });

      const client = new OpenAiModelClient(makeConfig(mock.url, { isStreaming: () => true }));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      assert.strictEqual(result.content, 'x');
    });

    it('forwards content deltas to onDelta as frames arrive, before the body ends', async () => {
      // A hand-rolled server that writes frames one at a time and only closes
      // the response after the client has observed the first fragment.
      let firstDeltaSeen: () => void = () => {};
      const firstDelta = new Promise<void>((resolve) => {
        firstDeltaSeen = resolve;
      });
      let responseEnded = false;
      const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n\n');
          void firstDelta.then(() => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            responseEnded = true;
            res.end();
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      mock = {
        url: `http://127.0.0.1:${port}`,
        captured: [],
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
      };

      const deltas: string[] = [];
      const endedWhenDeltaArrived: boolean[] = [];
      const client = new OpenAiModelClient(makeConfig(mock.url, { isStreaming: () => true }));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
        onDelta: (text) => {
          deltas.push(text);
          endedWhenDeltaArrived.push(responseEnded);
          firstDeltaSeen();
        },
      });

      assert.deepStrictEqual(deltas, ['Hel', 'lo']);
      // The first fragment reached the listener while the response was still open.
      assert.strictEqual(endedWhenDeltaArrived[0], false);
      assert.strictEqual(result.content, 'Hello');
    });
  });

  describe('SseCompletionParser', () => {
    it('handles a frame split across chunks and does not call onDelta for non-streaming text', () => {
      const deltas: string[] = [];
      const parser = new SseCompletionParser((t) => deltas.push(t));
      const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'héllo' } }] }) + '\n';
      const cut = Math.floor(frame.length / 2);
      parser.feed(frame.slice(0, cut));
      assert.deepStrictEqual(deltas, [], 'a partial line must not be parsed yet');
      parser.feed(frame.slice(cut));
      assert.deepStrictEqual(deltas, ['héllo']);
      // A trailing line without a newline is flushed by finish().
      parser.feed('data: ' + JSON.stringify({ choices: [{ delta: { content: '!' } }] }));
      const result = parser.finish();
      assert.deepStrictEqual(deltas, ['héllo', '!']);
      assert.strictEqual(result.content, 'héllo!');
      assert.deepStrictEqual(result.tool_calls, []);
    });

    it('keeps the id and name from the first chunk when later chunks carry nulls', () => {
      // Some OpenAI-compatible servers repeat the tool-call envelope on every
      // argument fragment with `"id": null` and `"function": {"name": null}`.
      // Those nulls must not overwrite the real id/name (Req 7.2).
      const parser = new SseCompletionParser();
      const frame = (toolCall: unknown): string =>
        'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] }) + '\n';
      parser.feed(frame({ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }));
      parser.feed(frame({ index: 0, id: null, function: { name: null, arguments: '{"path":' } }));
      parser.feed(frame({ index: 0, id: null, function: { name: null, arguments: '"a.txt"}' } }));
      parser.feed('data: [DONE]\n');

      const result = parser.finish();

      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ]);
    });

    it('keeps two calls separate when both arrive at index 0 with different ids', () => {
      const parser = new SseCompletionParser();
      const frame = (toolCall: unknown): string =>
        'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] }) + '\n';
      parser.feed(frame({ index: 0, id: 'call_1', function: { name: 'glob', arguments: '{"g":' } }));
      parser.feed(frame({ index: 0, id: null, function: { name: null, arguments: '"**"}' } }));
      parser.feed(frame({ index: 0, id: 'call_2', function: { name: 'git_status', arguments: '{}' } }));

      const result = parser.finish();

      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_1', name: 'glob', arguments: '{"g":"**"}' },
        { id: 'call_2', name: 'git_status', arguments: '{}' },
      ]);
    });

    it('drops a call that never received a string id and name', () => {
      const parser = new SseCompletionParser();
      parser.feed(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: null, function: { name: null, arguments: '{"a":1}' } },
                    { index: 1, id: 'call_ok', function: { name: 'git_status', arguments: '{}' } },
                  ],
                },
              },
            ],
          }) +
          '\n',
      );

      const result = parser.finish();

      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_ok', name: 'git_status', arguments: '{}' },
      ]);
    });

    it('returns undefined content when no content delta was ever seen', () => {
      const parser = new SseCompletionParser();
      parser.feed(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      const result = parser.finish();
      assert.strictEqual(result.content, undefined);
      assert.deepStrictEqual(result.tool_calls, [{ id: 'c1', name: 'f', arguments: '{}' }]);
    });
  });

  describe('missing-config messaging', () => {
    it('throws MissingConfigError naming the endpoint before any request', async () => {
      const client = new OpenAiModelClient(makeConfig(undefined));
      await assert.rejects(
        client.complete({ messages: SAMPLE_MESSAGES, tools: [], signal: liveSignal() }),
        (err: unknown) => {
          assert.ok(err instanceof MissingConfigError);
          assert.strictEqual(err.missing, 'endpoint');
          return true;
        },
      );
    });

    it('throws MissingConfigError naming the model', async () => {
      const client = new OpenAiModelClient(
        makeConfig('http://127.0.0.1:0', { getModel: () => undefined }),
      );
      await assert.rejects(
        client.complete({ messages: SAMPLE_MESSAGES, tools: [], signal: liveSignal() }),
        (err: unknown) => {
          assert.ok(err instanceof MissingConfigError);
          assert.strictEqual(err.missing, 'model');
          return true;
        },
      );
    });

    it('throws MissingConfigError naming the apiKey', async () => {
      const client = new OpenAiModelClient(
        makeConfig('http://127.0.0.1:0', { getApiKey: () => undefined }),
      );
      await assert.rejects(
        client.complete({ messages: SAMPLE_MESSAGES, tools: [], signal: liveSignal() }),
        (err: unknown) => {
          assert.ok(err instanceof MissingConfigError);
          assert.strictEqual(err.missing, 'apiKey');
          return true;
        },
      );
    });
  });

  describe('connection / timeout errors', () => {
    it('maps a refused connection to UnreachableEndpointError', async () => {
      // Reserve a port, then immediately close so nothing is listening on it.
      const idle = http.createServer();
      await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
      const { port } = idle.address() as AddressInfo;
      await new Promise<void>((resolve) => idle.close(() => resolve()));

      const client = new OpenAiModelClient(makeConfig(`http://127.0.0.1:${port}`));
      await assert.rejects(
        client.complete({ messages: SAMPLE_MESSAGES, tools: SAMPLE_TOOLS, signal: liveSignal() }),
        (err: unknown) => {
          assert.ok(err instanceof UnreachableEndpointError);
          return true;
        },
      );
    });

    it('aborts with UnreachableEndpointError when the connect budget elapses', async () => {
      // A server that accepts the socket but never responds, paired with a tiny
      // connect budget, forces the timeout path (Req 7.1, 7.6).
      const silent = http.createServer(() => {
        /* never write a response */
      });
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const { port } = silent.address() as AddressInfo;

      const client = new OpenAiModelClient(
        makeConfig(`http://127.0.0.1:${port}`, { connectTimeoutMs: 50 }),
      );
      try {
        await assert.rejects(
          client.complete({ messages: SAMPLE_MESSAGES, tools: SAMPLE_TOOLS, signal: liveSignal() }),
          (err: unknown) => {
            assert.ok(err instanceof UnreachableEndpointError);
            assert.match(err.message, /within 50ms/);
            return true;
          },
        );
      } finally {
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });
  });

  describe('tools / tool_calls round trip', () => {
    let mock: MockServer;
    afterEach(async () => {
      await mock.close();
    });

    it('sends the tools array on the wire and returns the requested tool_calls', async () => {
      mock = await startMockServer(() => ({
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"x"}' },
                  },
                  {
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"y"}' },
                  },
                ],
              },
            },
          ],
        }),
      }));

      const client = new OpenAiModelClient(makeConfig(mock.url));
      const result = await client.complete({
        messages: SAMPLE_MESSAGES,
        tools: SAMPLE_TOOLS,
        signal: liveSignal(),
      });

      // The wire request carried our tool as an OpenAI function tool.
      const sent = mock.captured[0].body as {
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: object } }>;
        model?: string;
      };
      assert.strictEqual(mock.captured[0].authorization, 'Bearer test-key');
      assert.strictEqual(sent.model, 'test-model');
      assert.ok(Array.isArray(sent.tools));
      assert.strictEqual(sent.tools!.length, 1);
      assert.deepStrictEqual(sent.tools![0], {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: SAMPLE_TOOLS[0].parameters,
        },
      });

      // And the tool_calls round-tripped back into the parsed result.
      assert.strictEqual(result.content, undefined);
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_a', name: 'read_file', arguments: '{"path":"x"}' },
        { id: 'call_b', name: 'read_file', arguments: '{"path":"y"}' },
      ]);
    });
  });
});
