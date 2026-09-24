# Plan T11

## Steps

1. Add a 'Providers and models' section to README.md, after '### Auto mode' and before '### The config panel'

   Insert a new `### Providers and models` subsection under the existing `## The Baiton views` chapter, placed immediately after the `### Auto mode` section (which ends with the line 'Which asks can reach these cards at all depends on the per-adapter relay, documented in **Harness ask relay (per-adapter probe findings)** below.') and immediately before `### The config panel` (line ~318). Match the surrounding prose style: `###`/`####` headings, bold lead-ins on bullet items, backticked identifiers, ~80-column wrapping, and references to concrete source symbols/files as the rest of the README does.

   The section must cover, factually and verifiably against the code:

   1. Intro paragraph: the orchestrator chat talks to one of five inference providers, chosen per workspace in the Chat view's **Provider & Model** dropdown. The whole catalog — ids, order, labels, base URLs, secret key names and built-in model lists — lives in `src/orchestrator/providers.ts`; the host side that owns one client per provider and delegates each completion to the active one is `ProviderRouter` in `src/activation/providerRouter.ts`. Switching providers changes the model used by the chat, by the tool loop and by Auto mode's stage-(b) evaluator at once, and changes nothing on disk: transcripts (`.baiton/chat/<id>.jsonl`, `.baiton/specs/<slug>/chat/<id>.jsonl`) are untouched by a switch.

   2. A table of the five providers, in catalog order (`PROVIDER_IDS`: copilot, google, opencode, mistral, openai) with columns `Provider` (the `label`), `Id`, `API key` and `Models`:
      - GitHub Copilot / `copilot` / none — runs in-window on your Copilot subscription / enumerated live from `vscode.lm.selectChatModels({ vendor: 'copilot' })`.
      - Google AI Studio / `google` / `baiton.orchestrator.key.google` / `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, against `https://generativelanguage.googleapis.com/v1beta/openai/`.
      - OpenCode Go / `opencode` / `baiton.orchestrator.key.opencode` / `grok-code`, `qwen3-coder`, `kimi-k2`, `claude-sonnet-4-5`, `gpt-5-codex`, against `https://opencode.ai/zen/v1`.
      - Mistral AI / `mistral` / `baiton.orchestrator.key.mistral` / `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `devstral-medium-latest`, against `https://api.mistral.ai/v1`.
      - OpenAI / Custom / `openai` / `baiton.orchestrator.key.openai` / whatever `baiton.orchestrator.model` names, against `baiton.orchestrator.endpoint`.
      Follow the table with a sentence noting the base URLs are prefixes: the client appends `/chat/completions`, and a trailing slash is stripped, so do not append the path yourself.

   3. `#### Per-provider API keys` — one key per provider in VS Code SecretStorage under `baiton.orchestrator.key.<provider>`; Copilot needs none. **Baiton: Set Provider API Key** (`baiton.setProviderApiKey`) quick-picks the keyed providers in catalog order (each row showing `API key set` / `No API key set`), then takes the value in a masked input. A non-empty submit stores the trimmed value and confirms without ever showing it; an empty submit clears an existing key, or reports that nothing changed when none was stored; dismissing either box changes nothing and says nothing; a storage failure leaves the previous value untouched and reports an error. Note that **Baiton: Set Orchestrator API Key** (`baiton.setOrchestratorApiKey`) stays registered as an alias so existing key bindings keep working, and that the pre-multi-provider single secret `baiton.orchestrator.apiKey` is migrated once into the `openai` slot (`migrateLegacyApiKey` in `src/activation/setApiKey.ts`, gated by the `baiton.orchestrator.keyMigrated` flag in `globalState`), so an already-configured setup keeps working with nothing to re-enter; the legacy secret is never deleted and is no longer read.

   4. `#### The Provider & Model dropdown` — a `<select>` at the top of the Chat view with one `<optgroup>` per provider in catalog order. A provider with no key (or Copilot when it is unavailable) renders as a disabled group whose options are disabled too, and a **Set API key…** link appears beside the dropdown whenever at least one group is disabled; its tooltip lists each disabled provider's reason — the exact strings are `providerNeedsKeyReason(id)` ("Set an API key for <label> to use it."), `PROVIDER_NEEDS_ENDPOINT_REASON` ("Set baiton.orchestrator.endpoint to use OpenAI / Custom.") and `COPILOT_UNAVAILABLE_REASON` ("GitHub Copilot is not available in this window. Install and sign in to GitHub Copilot Chat."), all in `src/orchestrator/providers.ts`. The host is authoritative exactly as the Auto-mode toggle is: picking a model posts `selectModel` and the dropdown repaints only when the host echoes `setProviders` back. A selection whose model no longer appears renders as a disabled `<provider> / <model> (unavailable)` placeholder, and the dropdown is disabled while a run is in flight or while no enabled provider offers a model. The selection is remembered per workspace in `workspaceState` under `baiton.orchestrator.selection` (`MODEL_SELECTION_KEY`), not in `settings.json` — the same arrangement as `baiton.chat.autoMode`. The Chat view's empty state now shows the active **provider** and **model** instead of the endpoint URL.

   5. `#### GitHub Copilot in-window mode` — Copilot runs through the in-process `vscode.lm` API (`src/orchestrator/copilotClient.ts`), so no API key, no endpoint and no network configuration of Baiton's is involved: access rides on the user's Copilot subscription. Models are enumerated live with `vscode.lm.selectChatModels({ vendor: 'copilot' })`, so the group is empty and disabled when Copilot Chat is not installed or is signed out. The first request raises VS Code's own consent dialog, justified with "Baiton runs the orchestrator chat and its tools through your Copilot subscription." Tool calling is full: `ToolSpec`s map to `LanguageModelChatTool`s, streamed text parts reach the chat as deltas, tool-call parts come back as `tool_calls`, and **Stop** cancels through a `CancellationTokenSource`. A missing model or a refused/blocked request maps onto the same error classes as the HTTP clients (`MissingConfigError('model')`, `UnreachableEndpointError`), so the inline error banner and its fix action behave unchanged; `MissingConfigError('apiKey')` is never raised for Copilot.

   6. `#### Gemini tool chaining` — Google's OpenAI-compatible translation rejects (or silently truncates) three shapes the unified transcript can produce, which is why a multi-step tool loop used to stall until a new user message arrived. Requests to `google` therefore go through the `gemini` wire dialect (`shapeGeminiMessages` in `src/orchestrator/modelClient.ts`): an assistant turn carrying `tool_calls` omits `content` entirely when it would be empty or whitespace; every `tool` message is re-attached directly after the assistant turn that requested its `tool_call_id` and carries exactly `role`, `tool_call_id` and `content`; tool-call `arguments` are sanitised to a JSON object string. Orphan tool messages are dropped, and a `tool_call_id` reused across two assistant turns is drained onto its first requester only. The shaping is on the wire only — the transcript on disk is unchanged — so multi-step tool calls chain without user intervention.

   7. `#### OpenCode Go request headers` — every OpenCode request carries `user-agent: baiton/<extension version>` and `x-opencode-session: <uuid>`, where the uuid is minted once per chat session id (threaded through as `CompletionRequest.sessionId`) and stays stable for the whole conversation.

   Files: `README.md`

2. Document baiton.setProviderApiKey in README's Commands list

   In the `## Commands` list (README.md ~lines 480-489), after the existing **Baiton: Set Orchestrator API Key** bullet, add:

   - **Baiton: Set Provider API Key** (`baiton.setProviderApiKey`) — picks one of the keyed providers, then sets or clears its API key with a masked input, stored in VS Code SecretStorage under `baiton.orchestrator.key.<provider>`.

   And reword the existing **Baiton: Set Orchestrator API Key** bullet so it no longer reads as the only key command: state that it is an alias for **Set Provider API Key**, kept so existing key bindings keep working. Both commands are already contributed in `package.json` and both already appear under `menus.commandPalette` gated on `baiton.activated`, so no `package.json` command/menu change is needed here — verify that before editing and do not add duplicates.

   Files: `README.md`

3. Rewrite README's Settings section so endpoint/model read as the OpenAI / Custom provider

   Replace the two-paragraph `## Settings` section at the end of README.md (currently: 'Besides the endpoint, model, streaming and round-bound settings, the orchestrator accepts `baiton.orchestrator.maxTokens`: …') with a short list that keeps every fact already documented and re-frames endpoint/model:

   - `baiton.orchestrator.endpoint` — base URL of the OpenAI-compatible chat-completions endpoint used by the **OpenAI / Custom** provider. It does not affect the other four providers, whose base URLs come from the provider catalog (`src/orchestrator/providers.ts`).
   - `baiton.orchestrator.model` — the model id offered under **OpenAI / Custom**. Same note: the other providers list their own models (Copilot enumerates its own live).
   - `baiton.orchestrator.streaming` — unchanged wording (stream assistant text as generated; disable if the endpoint does not support server-sent events).
   - `baiton.orchestrator.maxTokens` — keep the current sentence verbatim in substance: the maximum number of tokens asked for per completion, sent as `max_tokens`, defaulting to `0`, which leaves `max_tokens` off the request entirely so the endpoint's own default applies.
   - `baiton.orchestrator.roundBound` — maximum model completions in one orchestrator tool-loop run; unset / non-positive / below 1 falls back to 20.

   Close the section with one sentence pointing out what is deliberately NOT a setting: API keys live in SecretStorage (see **Per-provider API keys**) and the active provider/model lives in `workspaceState` under `baiton.orchestrator.selection`. Cross-link the new **Providers and models** section by name from here.

   Files: `README.md`

4. Update the endpoint/model setting descriptions in package.json

   In `package.json` under `contributes.configuration.properties`, edit only the two `description` strings (keep every `type`, `default`, `minimum` and the key order exactly as they are — do not reformat the file, and preserve its 2-space indentation and trailing newline):

   - `baiton.orchestrator.endpoint` (line ~295): change
     "Base URL of the OpenAI-compatible chat-completions endpoint the orchestrator uses."
     to
     "Base URL of the OpenAI-compatible chat-completions endpoint used by the 'OpenAI / Custom' orchestrator provider. The other providers (GitHub Copilot, Google AI Studio, OpenCode Go, Mistral AI) use their own built-in endpoints and ignore this setting."

   - `baiton.orchestrator.model` (line ~300): change
     "Model identifier the orchestrator requests."
     to
     "Model identifier offered under the 'OpenAI / Custom' orchestrator provider. The other providers list their own models in the Chat view's Provider & Model dropdown and ignore this setting."

   Optionally also extend `baiton.orchestrator.streaming`'s description with a clause noting it applies to the HTTP providers (GitHub Copilot always streams through `vscode.lm`) — only if that is confirmed true in `src/orchestrator/copilotClient.ts`; otherwise leave it exactly as it is. Leave `maxTokens` and `roundBound` untouched. Make no change to `contributes.commands` or `contributes.menus`: `baiton.setProviderApiKey` is already contributed and already palette-gated.

   Files: `package.json`

5. Verify the documented strings against the code before finishing

   Every identifier and user-facing string written into README.md must be checked against its source rather than restated from memory:
   - ids, order, labels, base URLs, model lists, secret-key prefix, `MODEL_SELECTION_KEY`, `LEGACY_API_KEY_SECRET`, and the three reason strings — `src/orchestrator/providers.ts`;
   - command ids and titles — `package.json` `contributes.commands`;
   - quick-pick/masked-input behaviour, clear-on-empty, and `migrateLegacyApiKey`'s `LEGACY_MIGRATION_FLAG` — `src/activation/setApiKey.ts`;
   - `COPILOT_VENDOR`, `COPILOT_JUSTIFICATION`, the error mapping and the `CancellationTokenSource` abort path — `src/orchestrator/copilotClient.ts`;
   - the Gemini shaping rules, the `user-agent`/`x-opencode-session` header names and the per-`sessionId` uuid — `src/orchestrator/modelClient.ts`;
   - the `(unavailable)` placeholder text, the **Set API key…** affordance and its tooltip, the disabled-while-busy rule, and the provider/model empty state — `media/chat.js` / `media/chat.html`;
   - `setProviders` / `selectModel` message names — `src/orchestrator/webviewProtocol.ts`.
   If any of them differs from what this plan states, the code wins: document what the code does.

   Files: `README.md`, `src/orchestrator/providers.ts`, `src/activation/setApiKey.ts`, `src/orchestrator/copilotClient.ts`, `src/orchestrator/modelClient.ts`, `media/chat.js`, `src/orchestrator/webviewProtocol.ts`

## Risks

- The plan quotes catalog values (model ids, base URLs, reason strings) read at planning time; if any drifted, the README would assert something false. Mitigated by the final verification step — re-read each source before writing the prose.
- package.json is machine-read by VS Code and by the build; a stray comma or re-indentation while editing two description strings breaks packaging. Edit only the two string values and re-parse the file afterwards.
- README.md is long and already covers Auto mode and the relay probes in depth; inserting the new section in the wrong place (e.g. after the relay findings, or under ## Commands) would break its reading order. The insertion point is between '### Auto mode' and '### The config panel'.
- Over-documenting internals: the README's audience is users. Keep source-symbol references at the level the existing text already uses (a file or symbol name in backticks as a pointer), not an implementation walkthrough.
- OpenCode Go's base URL and model list are the catalog's best-effort values, documented in providers.ts as a deliberate single edit point. The README should state them as what Baiton uses, without implying they were verified against a live gateway.
- No test asserts README or package.json description content, so nothing fails if a fact is wrong — correctness here rests entirely on the verification step.

## Acceptance

- README.md has a new '### Providers and models' section between '### Auto mode' and '### The config panel' that names all five providers in catalog order with their ids, key requirement and models, and has the four sub-headings: per-provider API keys, the Provider & Model dropdown, GitHub Copilot in-window mode, and Gemini tool chaining (plus the OpenCode header note).
- README.md documents that keys live in SecretStorage under 'baiton.orchestrator.key.<provider>', that Copilot needs no key, and that the legacy 'baiton.orchestrator.apiKey' secret is migrated once into the openai slot so existing setups keep working.
- README.md's '## Commands' list includes 'Baiton: Set Provider API Key' (baiton.setProviderApiKey) and describes 'Baiton: Set Orchestrator API Key' as the retained alias.
- README.md's '## Settings' section describes baiton.orchestrator.endpoint and baiton.orchestrator.model as the OpenAI / Custom provider's settings, and still documents streaming, maxTokens (default 0 omits max_tokens) and roundBound (fallback 20).
- package.json's baiton.orchestrator.endpoint and baiton.orchestrator.model descriptions name the 'OpenAI / Custom' provider and say the other providers ignore them; no other property, command or menu entry changed.
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` succeeds and `git diff package.json` shows only the intended description lines (2-space indentation and trailing newline preserved).
- `npx tsc --noEmit -p tsconfig.json` is clean and `npm run test:unit` is green at or above the T10 baseline (1337 passing / 1 pending) — documentation-only changes must move neither.
- Every provider id, label, base URL, model id, secret key, command id, reason string and message name written into README.md matches the source files listed in the verification step.
