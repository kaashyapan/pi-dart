# Writing Extensions for @earendil-works/pi-coding-agent

A practitioner's guide to the pi extension API, distilled from reading the
runtime source (`dist/core/extensions/`) and building real extensions
(pi-dart, pi-moonbit). Everything here is verified against
`@earendil-works/pi-coding-agent` 0.85.x — behavior noted as "verified" was
confirmed by reading the runner/loader implementation or executing it, not
inferred from docs.

---

## 1. What an extension is

An extension is a TypeScript or JavaScript file with a default-exported async
factory. Pi loads it, calls it once with an `ExtensionAPI` instance, and the
factory registers everything synchronously during that call:

```typescript
// .pi/extensions/my-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  pi.registerTool({ /* ... */ });
  pi.registerCommand("my-cmd", { handler: async (args, ctx) => { /* ... */ } });
  pi.on("tool_call", (event) => { /* intercept tools */ });
}
```

### Where pi discovers extensions

From `package-manager.js` (`collectAutoExtensionEntries`), in order:

| Location | Loaded when | Discovery |
|---|---|---|
| `.pi/extensions/` (project) | **only if the project is trusted** | every `*.ts`/`*.js` file directly in the dir; each subdirectory is consulted via its own `package.json` `pi.extensions` array or an `index.ts`/`index.js` |
| `~/.pi/agent/extensions/` (global) | always | same discovery rules |
| `pi.extensions` in a package's `package.json` | when the package is installed as a pi package | explicit entry list |
| Temporary/CLI extension paths | always | explicit |

Discovery details that matter:

- Dotfiles and `node_modules/` inside an extensions dir are skipped.
- A subdirectory with a `package.json` containing `pi.extensions: ["./x.ts"]`
  uses exactly those entries; otherwise `index.ts`/`index.js` is the entry;
  otherwise the directory contributes nothing.
- **Project extensions require project trust.** On first load in a new
  project, pi runs a bootstrap pass with trust disabled (global extensions
  load, project ones don't), then prompts the user to trust the project.
  A trusted project's extensions load normally.
- `/reload` clears the extension cache and re-runs the whole discovery +
  load cycle.

### Packaging as an npm package

`package.json` for a pi package:

```jsonc
{
  "name": "pi-mylang",
  "type": "module",
  "pi": { "extensions": ["./extensions/mylang.ts"] },
  "files": ["extensions", "README.md", "LICENSE", "tsconfig.json"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

Every file listed in `pi.extensions` **and every module it imports** must be
in `files`. A CI check that greps `bun pm pack --dry-run` output for each
module catches packaging omissions (pi-moonbit/pi-dart both do this).

---

## 2. The registration API

### `pi.registerTool(tool)` — the LLM-facing surface

```typescript
pi.registerTool({
  name: "dart_analyze",              // name the LLM calls
  label: "Dart: Analyze",            // human label for the UI
  description: "...",                // the LLM's primary selection signal
  promptSnippet?: "...",             // one line for the "Available tools" section
  promptGuidelines?: string[],       // bullets appended to the system prompt
  parameters: Type.Object({ ... }),  // TypeBox schema
  executionMode?: "sequential" | "parallel",
  prepareArguments?(args): Static<TParams>,  // pre-validation shim
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [...], details: { ... } };
  },
  renderCall?, renderResult?,        // custom TUI rendering
});
```

Key behaviors, verified against the runtime:

- **`execute` returns `AgentToolResult`** = `{ content, details, usage?,
  addedToolNames?, terminate? }`. There is **no `isError` field**. This is
  the single most surprising fact about the API — see §4.
- **Throwing is the error path** for crashes: `executePreparedToolCall`
  catches a throw and replaces the entire result with
  `{ content: [{ type: "text", text: message }], details: {} }`. Your
  carefully built summary is gone. Don't throw for expected failures
  (failing tests, linter errors) — encode them in content and flag via
  `tool_result` (§4).
- **Arguments arrive validated** against the TypeBox schema. All TypeBox
  `Type.*` combinators work; use `Type.Optional(...)` for optional params
  and lean on `description` strings heavily — they're the only
  documentation the model sees for each parameter.
- **`signal` (AbortSignal)** is undefined-able. Pass it through to
  `execFile`/`fetch`/etc. The agent loop checks `signal.aborted` between
  tool calls; inside your tool, honoring it means killing subprocesses.
- **`onUpdate(partialResult)`** streams partial results to the UI while the
  tool runs (typed as `AgentToolUpdateCallback`). Calls after the promise
  settles are ignored.
- **`ctx: ExtensionContext`** carries `cwd` (the session's working
  directory), `ui`, `sessionManager`, `model`, `signal`, and more. Always
  run subprocesses against `ctx.cwd`, not `process.cwd()`.
- **`executionMode: "sequential"`** forces this tool to run one-at-a-time
  relative to other calls in a batch. Default is parallel.
- **`promptGuidelines`** are appended to the *default* system prompt when
  the tool is active — good for sequencing rules ("analyze before test").
  Keep them short; they cost context every turn.

Tool selection is driven almost entirely by `name` + `description` +
parameter descriptions. Write descriptions as instructions to the model
("Run this after edits and before X — cheaper than Y"), not as API docs.

### `pi.registerCommand(name, options)` — slash commands

```typescript
pi.registerCommand("dart-doctor", {
  description: "Check whether the Dart SDK is reachable...",
  getArgumentCompletions?: (prefix) => string[] | null,
  handler: async (args: string, ctx: ExtensionCommandContext) => {
    ctx.ui.notify("message", "info" | "warning" | "error");
  },
});
```

The command context extends `ExtensionContext` with user-initiated-only
methods (`newSession`, `fork`, `waitForIdle`). Commands are the right place
for human-facing diagnostics that shouldn't exist as model tools.

### `pi.on(event, handler)` — the event system

Handlers may be sync or async; a returned object modifies behavior, `undefined`
passes through. Events, grouped by what they can do:

**Interception (return a result to act):**

| Event | Return to act | Notes |
|---|---|---|
| `tool_call` | `{ block?, reason?, terminate? }` | fires before any tool executes; `event.input` is **mutable in place** to patch args; later handlers see mutations |
| `tool_result` | `{ content?, details?, isError?, usage? }` | field-by-field override of the outgoing tool-result message; **the only supported way to set isError** |
| `user_bash` | `{ operations?, result? }` | custom bash execution or full result replacement |
| `input` | `{ action: "continue" } \| { action: "transform", text, images? } \| { action: "handled" }` | transform or consume user input before the agent |
| `message_end` | `{ message }` | replace the finalized message; must keep the role |
| `context` | `{ messages? }` | modify messages sent as LLM context |
| `before_agent_start` | `{ message?, systemPrompt? }` | systemPrompt replacements chain across extensions |
| `before_provider_request` / `before_provider_headers` | payload/header injection | |
| `project_trust` | `{ trusted: "yes"|"no"|"undecided", remember? }` | |
| `session_before_switch` / `session_before_fork` / `session_before_compact` | `{ cancel? }` | veto transitions |

**Observation (no result):** `session_start`, `session_shutdown`,
`agent_start`/`agent_end`/`agent_settled`, `turn_start`/`turn_end`,
`message_start`/`message_update`, `tool_execution_start`/`_update`/`_end`,
`model_select`, `thinking_level_select`, `resources_discover`,
`ui_prompt_start`/`_end`, `after_provider_response`.

### Other registration surfaces

```typescript
pi.registerShortcut(keybinding, { description, handler(ctx) });  // TUI keybinding
pi.registerFlag(name, { type: "boolean"|"string", default, description });
pi.getFlag(name);                       // read flag values
pi.registerMessageRenderer(customType, renderer);   // render CustomMessageEntry
pi.registerEntryRenderer(customType, renderer);     // session entries (not LLM-visible)
pi.registerMarkdownTransformer(fn);     // transform markdown before TUI rendering
pi.registerProvider(name, config);      // custom/overridden model providers
pi.unregisterProvider(name);
```

Session-side utilities available on `pi` (and worth knowing before building
state by hand): `sendMessage` (custom message with
`deliverAs: "steer" | "followUp" | "nextTurn"`), `sendUserMessage`
(always triggers a turn; `expandPromptTemplates` dispatches slash commands),
`appendEntry` (persist state into the session file — not LLM-visible),
`setSessionName`, `setLabel`, `exec`, `getActiveTools` / `setActiveTools`,
`getAllTools`, `getCommands`, `setModel`, `getThinkingLevel` /
`setThinkingLevel`, `getContextUsage`, `compact`, `getSystemPrompt`,
`abort`, `shutdown`.

---

## 3. ExtensionContext

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;       // select/confirm/input/notify dialogs
  mode: ExtensionMode;          // guard TUI-only UI with mode checks
  hasUI: boolean;               // dialog-capable? (TUI + RPC)
  cwd: string;                  // session working directory
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model | undefined;
  scopedModels: readonly ScopedModel[];
  thinkingLevel?: ThinkingLevel;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;  // current streaming signal
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?): void;
  getSystemPrompt(): string;
}
```

`ui.notify(message, type)` is the fire-and-forget channel for human-visible
messages. `ui.select`/`confirm`/`input` are promise-based dialogs; guard
them behind `hasUI`/`mode` in headless runs.

---

## 4. The isError contract — the #1 trap

`AgentToolResult` (what `execute()` returns) has **no `isError` field**.
Consequences, verified in `pi-agent-core/dist/agent-loop.js`:

1. Returning `{ content, details, isError: true }` compiles (extra
   properties are structurally fine) and **silently does nothing**. The
   flag never reaches the model or the UI.
2. Throwing replaces your whole result with the exception text.
3. The supported seam is the **`tool_result` event**: its handler may return
   `{ isError?: boolean, details?, content?, usage? }`, merged field-by-field
   into the outgoing tool-result message (`agent-session.js` →
   `runner.emitToolResult`).

The established pattern (used by pi-dart/pi-moonbit):

```typescript
const FAILURE_FLAG = "flagsDiagnosticFailure";

// in execute(): mark failures in details, keep the full content
return {
  content: [{ type: "text", text: summary }],
  details: failed ? { ...details, [FAILURE_FLAG]: true } : details,
};

// once, at extension top level:
pi.on("tool_result", (event) => {
  const d = event.details as Record<string, unknown> | undefined;
  if (!d || d[FAILURE_FLAG] !== true) return;
  return { details: { ...d, [FAILURE_FLAG]: undefined }, isError: true };
});
```

Register the hook **unconditionally** at extension top level: before the
tools exist it matches nothing, and after `/reload` brings tools online it's
already in place. The model keeps the full summarized content *and* gets
provider-level error framing.

**Test-suite consequence:** a stub ExtensionAPI that executes handlers
directly will happily assert on `res.isError` — a test of your code against
itself, not against the runtime. Assert on the marker in `details`, and keep
one integration test through the real hook path.

---

## 5. Tool-call interception (bash redirect pattern)

`tool_call` fires before the named tool executes. Returning
`{ block: true, reason }` stops execution; `reason` is surfaced to the model
in place of a result, so it self-corrects next turn. `event.input` is
mutable — patch arguments in place for argument normalization.

pi-dart/pi-moonbit use this to hard-block bash invocations that duplicate
registered tools:

```typescript
pi.on("tool_call", (event) => {
  if (event.toolName !== "bash") return;
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  const redirect = findRedirect(command);
  if (!redirect) return;
  return { block: true, reason: `Use the ${redirect.tool} tool instead — ${redirect.note}` };
});
```

Rules learned the hard way:

- **Strip quoted segments** before matching (`echo "dart test"` must pass
  through), then **match only at command positions** (start of a segment or
  after `;`, `&&`, `||`, `|`, `$()`, backticks). Mentions are not calls.
- **Guard every shell tool**: on Windows the model can bypass a bash-only
  block through `powershell`. Match both event types.
- **Only register the block when the replacement tool is active** — blocking
  bash with no working alternative strands the model with neither option.
- Don't block things you deliberately didn't wrap (`build_runner watch`).

---

## 6. Lifecycle, cancellation, subprocesses

- `AbortSignal` flows into `execute(toolCallId, params, signal, onUpdate, ctx)`.
  Pass it to `execFile`'s `signal` option / `fetch`. An aborted call should
  resolve with a clear "Cancelled." result — never fabricate success.
- `execFile` failure shapes (Node ≥22, verified): **spawn failure** has no
  numeric `error.code`; **timeout kill** has `error.killed: true` and
  `code: null`; **normal non-zero exit** has a numeric `code`. Distinguish
  all three — "tool timed out" and "binary not on PATH" demand different
  model responses.
- Always pass a `timeout` to `execFile` and a `maxBuffer` (10 MB is a safe
  default for compiler output). Long-running watch modes don't belong in
  one-shot tools.
- Capture stdout/stderr **separately** and render them as distinct sections;
  merging loses attribution.
- Truncate defensively (20 KB + a `[truncated N chars]` note) — compiler and
  test output is unbounded in the wild.

### Toolchain gating

Check the external binary once at load (`--version`); register the tools
**only if it succeeds**. An always-failing tool is worse than no tool: the
model retries it and misattributes failures to the code. Always register a
`*-doctor` command so a human can diagnose reachability after fixing PATH
(and tell them to run `/reload` — the doctor can't re-register). Some
binaries print `--version` to stderr (older Dart); read both streams.

---

## 7. Testing an extension

Pattern proven in pi-moonbit/pi-dart (49–51 tests each):

1. **Stub ExtensionAPI** collecting registrations:

```typescript
const tools = new Map(), commands = new Map(), listeners = new Map();
const pi = {
  registerTool: (t) => tools.set(t.name, t),
  registerCommand: (n, s) => commands.set(n, s),
  on: (e, h) => listeners.set(e, h),
};
await extension(pi);
```

2. **Execute real handlers** against committed fixture projects:

```typescript
const res = await tools.get("my_tool").execute("test-id", params, undefined, undefined, { cwd: FIXTURE_DIR });
```

3. **Unit-test the pure helpers** (parsers, summarizers, redirect matchers)
   with output captured from *real* toolchain runs, including the error and
   edge shapes.
4. **Assert the runtime contract, not your own return shape**: failure
   markers in `details`, never `res.isError`; and test the `tool_result`
   listener itself.
5. **Cover negative space**: mentions vs calls for redirects, malformed
   lines for parsers, cold state / missing binary / timeout for exec.
6. **Never let tests mutate committed fixtures** — apply-style tests run in
   a throwaway copy (`mkdtempSync` + `cpSync`).

CI notes: install the real toolchain, log its exact version (upstream
"latest-only" installers drift), resolve fixture dependencies in the
workflow, and never commit `.dart_tool`/`_build`/`node_modules` state whose
absolute paths are machine-specific — a committed `package_config.json`
pointing at your home dir passes locally and fails everywhere else.

---

## 8. Design heuristics

- **One tool per CLI intent**, not one tool with a `command` enum — each
  intent has a different parameter shape, and separate tools give the model
  clearer selection signal.
- **Dry-run by default for anything that writes**; require an explicit
  `apply: true`, and show the computed summary either way (moon_rename,
  dart_fix).
- **Token efficiency is a feature**: summarize compiler/test output, group
  by file, cap with "+N more", filter log noise to the lines that matter.
  Measured: dart test's NDJSON stream → pass/fail summary is ~10× smaller;
  build_runner's builder log filter is ~60×.
- **Non-zero exit ≠ error** when the exit code is the *product* (linter
  found issues, tests failed). Flag those via `tool_result` so the model
  fixes the code; reserve thrown errors and spawn failures for
  infrastructure problems.
- **Gate on toolchain presence; degrade gracefully.** The doctor command
  pattern closes the recovery loop for humans.
- **Description strings are prompt engineering.** "Run X after edits and
  before Y; prefer this over Z" beats "Runs the X utility."
- **Environment-shaped failures deserve hints**: if a fresh checkout
  produces phantom errors (unresolved package imports), say so in the
  result ("has `pub get` been run here?") with a conservative threshold so
  mixed signal isn't misattributed.
- **Version drift is a lifecycle concern**: when the wrapped CLI changes
  output across versions, make tests tolerant where behavior is
  incidental, strict where it's load-bearing, and log the toolchain version
  in CI.

---

## 9. Quick-start checklist

- [ ] Entry file with default-exported async factory
- [ ] TypeBox `parameters` with descriptive per-field strings
- [ ] `execute` returns `{ content, details }`; no `isError` field
- [ ] Failure marking via details + unconditional `tool_result` hook
- [ ] `signal` honored; subprocess timeouts + `maxBuffer` set
- [ ] `ctx.cwd` used for all subprocesses
- [ ] Toolchain gate + always-registered doctor command
- [ ] Bash redirect with quoted-segment stripping + command-position
      matching, registered only when tools are live
- [ ] Truncation on all output
- [ ] Tests: stub-API harness, fixture projects, pure-helper units,
      runtime-contract assertions
- [ ] `package.json` with `pi.extensions`, `files`, peerDependencies;
      CI check that the pack tarball contains every imported module
