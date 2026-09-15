# dart Pi extension

Wraps `dart analyze`, `dart test`, `dart fix`, and `dart run build_runner build` as discrete
Pi tools with summarized, token-efficient output — so the model gets a compact diagnostics
list instead of raw compiler/test/build-log text, and gets steered away from re-implementing
the same checks via raw `bash` calls.

Modeled directly on [kaashyapan/pi-moonbit](https://github.com/kaashyapan/pi-moonbit)'s
`moonbit.ts` — package import path, `execFile`-based subprocess handling, toolchain gating,
`isError` semantics, and the bash-redirect mechanism below all follow its conventions.

## Install

This extension is three files: `dart.ts` (the extension itself) plus two sibling helper
modules it imports, `dartexec.ts` (subprocess handling) and `doctor.ts` (toolchain check) —
mirroring how pi-moonbit splits `moonexec.ts`/`doctor.ts` out from `moonbit.ts`. Copy all three
together; `dart.ts` won't resolve its imports without them.

Project-local (recommended to start):

```
mkdir -p .pi/extensions
cp extensions/dart.ts extensions/dartexec.ts extensions/doctor.ts .pi/extensions/
```

Global (all projects):

```
mkdir -p ~/.pi/agent/extensions
cp extensions/dart.ts extensions/dartexec.ts extensions/doctor.ts ~/.pi/agent/extensions/
```

Reload Pi (`/reload`, or restart) after adding it.

## Why no LSP tools (definition/hover/references/rename)

Those are deliberately out of scope here. Dart's navigation intelligence lives in a
persistent, stateful analysis server (`dart language-server`), not a one-shot CLI —
[pi-lens](https://github.com/apmantza/pi-lens) already ships a built-in Dart LSP client with
process lifecycle management, document sync, cancellation, and orphan-process reaping solved.
Duplicating that here would mean re-solving problems pi-lens has already iterated through
several releases on, for no benefit. Install pi-lens alongside pi-dart if you want
hover/definition/references/rename; pi-dart covers the project-wide build/quality checks that
per-file LSP diagnostics don't (see [apmantza/pi-lens#627](https://github.com/apmantza/pi-lens/issues/627)
for why that's a real, separately-tracked gap even on the LSP side).

## Toolchain gating

At startup the extension runs `dart --version`. The four tools are registered **only if that
succeeds** — a tool that always fails with "command not found" is worse than no tool at all,
since the model tends to either retry it or misattribute the failure to something in the code
rather than the environment.

A `dart-doctor` command is **always** registered, regardless of the startup result:

```
/dart-doctor
```

It re-runs `dart --version` on demand and reports either the version string (plus whether the
dart_* tools are currently active) or the failure reason. If `dart` becomes reachable after a
failed startup check, run `/reload` afterward to actually register the tools —
`/dart-doctor` only diagnoses, it doesn't re-register anything itself.

## Bash redirection

Tool descriptions are only a soft nudge — models reach for `bash` anyway since it's more
familiar than picking the specifically-named tool. This extension hard-enforces the nudge via
a `pi.on("tool_call", ...)` handler that fires before any tool executes: if the model tries to
run `dart analyze`, `dart test`, `dart fix`, or `dart run build_runner build` directly through
`bash`, the call is **blocked**, and the block reason names the dedicated tool to use instead
(and briefly why — e.g. "it dry-runs by default"). This is the actual mechanism pi-moonbit
uses for this ("bash redirects"), not a shell-level output redirect — an earlier draft of this
file misread that term as `2>&1`/`</dev/null` shell redirection, which is unrelated and has
been reverted.

Matching is conservative, following pi-moonbit's `bash-redirect.ts`: quoted segments are
stripped and patterns are only tested at shell command positions (start of a segment or after
`;`, `&&`, `||`, `|`, `$()`, backticks). `echo "dart test"` or `grep 'dart analyze' notes.md`
passes through to bash untouched; `cd pkg && dart test` is blocked.

This redirect is only registered once the dart_* tools themselves are active (i.e. only if the
startup check passes) — blocking bash with no working replacement would strand the model with
neither option. `dart run build_runner watch` is deliberately **not** in the redirect list,
since there's no dedicated tool for it (see "Deliberately left out" below); bash remains the
correct way to run it.

## Tools registered

- `dart_analyze` — `dart analyze --format=machine`, parsed and summarized by file/severity
- `dart_test` — `dart test -r json`, summarized to pass/fail counts + failure details
- `dart_fix` — preview or apply automated analyzer fixes (dry-run by default)
- `build_runner` — `dart run build_runner build`, log-filtered to warnings/errors + summary line

(All four are gated behind the `dart --version` check — see "Toolchain gating" above.)

### Cancellation and timeouts

Every tool passes the Pi `AbortSignal` straight through to `execFile`'s native `signal` option
in `dartexec.ts` (no manual timer/kill handling) — an aborted call resolves with a "Cancelled."
result rather than a fabricated success or failure. Each tool also sets `execFile`'s `timeout`
option:

- `dart_analyze` / `dart_fix`: 60s
- `dart_test`: 120s
- `build_runner`: 300s (first-run codegen can be slow)

`dartexec.ts` exposes a `timedOut` flag (from `execFile`'s `error.killed`) distinguishing
"killed by our own timeout" from other null-exit-code outcomes — the dart_* tools use it to
report a clear "timed out after Xs" message.

### Output handling

Streams are captured separately via `execFile` (`stdout`, `stderr`) and are **not** merged —
each tool shows them as distinct sections (e.g. a trailing `stderr:` block) rather than trying
to interleave them, which matches how pi-moonbit handles `moon_fmt`/`moon_test` output. Output
is truncated at 20,000 characters with a `[truncated N chars]` note, since `dart_analyze` and
`build_runner` can both produce large output on a big project.

### Working directory

Every tool resolves against the Pi session's `ctx.cwd` (with an optional `path` param to
target a specific package/dir), same rationale as pi-moonbit: important for multi-package
Dart/Flutter workspaces and when the session isn't already inside the target package.

### Error framing (pi API difference from pi-moonbit)

In the current `@earendil-works/pi-coding-agent` runtime, a tool's `execute()` return value
has **no `isError` field** — returning a normal result is never presented as an error, and
throwing would replace the summarized content with the raw exception text. Instead, each tool
marks failing outcomes (analyze errors, failing tests, failed builds) with a
`flagsDiagnosticFailure` marker in `details`, and a `pi.on("tool_result", ...)` hook translates
that marker into `isError: true` on the outgoing tool-result message. The model keeps the full
summarized content *and* gets the error framing. pi-moonbit's `isError: true`-in-the-return
pattern predates this; the semantics it was reaching for live in the `tool_result` hook now.

### dart_analyze specifics

`dart analyze --format=machine` writes one diagnostic per line to stdout, pipe-delimited
(`SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE`) with `|`, `\`, and newlines
backslash-escaped (verified on SDK 3.13). Both stdout and stderr are scanned defensively since
any line that doesn't match the format parses to `null` and is filtered out at no cost.
Non-zero exit is *normal* (the project has any issue, even a single lint) — only diagnostics
with severity `ERROR` flag the call as a failure; warnings/lints are reported but don't. Exit
code 2 = warnings/infos only, 3+ = errors present. Output is grouped by file and capped by
`diagnosticLimit` (default 50), with a "+N more" note past the cap.

### dart_test specifics

`dart test -r json` emits one JSON event per line on stdout (testStart/testDone/error/done).
This is folded into a pass/fail/skipped count, with failure details (message + first stack
frames) only for tests that actually failed — not the full event stream. Counting rules
pinned to package:test 1.32's real stream: `testDone` events with `"hidden": true` are loader
bookkeeping ("loading test/foo_test.dart") and are skipped, or every run double-counts;
compile errors surface as a non-hidden `testDone` with result `"error"` and are counted as
failures. Exit 79 ("no tests ran" — e.g. the name filter matched nothing) is reported as its
own outcome rather than a bare "0 passed, 0 failed". Non-zero exit (failed tests) is a normal
process outcome, flagged via the `tool_result` hook so the model treats it as something to
fix. `name` is passed as `--plain-name` (substring match) — `--name` is regex-flavored, which
is almost never what a model means when it says "filter by name".

### dart_fix specifics

Dry-runs by default (`--dry-run`); `apply: true` switches to `--apply`. This is intentional
friction, same as `moon_rename` — a preview call must never silently become a write, and the
computed summary is shown either way so applying is an informed decision. **Caveat:** `dart
fix` has no `--format=json`, so the summarizer pattern-matches its text output. The pinned
shape is SDK 3.13's (`N proposed fix(es) in N file(s).`, per-file `lib/foo.dart` +
`code - N fix` lines, `N fix(es) made in N file(s).` on apply). If a future SDK rewords this,
the summarizer falls back to a capped raw excerpt rather than dropping information silently —
but you may want to adjust the regexes in `summarizeFixOutput`.

### build_runner specifics

Runs `dart run build_runner build` (optionally with `--delete-conflicting-outputs`).
build_runner's default log is very noisy (one line per builder per file); this filters stdout
and stderr independently down to `E`/`W` level lines plus the final `Built with
build_runner/aot in Ns` / `Failed to build with ...` summary line, capped at 60 filtered
lines. (Older build_runner releases used `[SEVERE]`/`[WARNING]` prefixes and `Succeeded
after`; those patterns are kept defensively.) Falls back to the last 20 lines of each stream
if nothing matches — a clean run still needs *some* confirmation shown, and fatal setup
errors (e.g. no `pubspec.yaml` anywhere) arrive on stderr.

## Deliberately left out

- **LSP-style navigation** — see "Why no LSP tools" above; use pi-lens.
- **`build_runner watch`** — long-running by nature, not a fit for a one-shot tool call, and
  explicitly excluded from bash redirection too (see "Bash redirection" above). Run it manually
  in a terminal if you want continuous codegen during a session.
- **`dart test --update-goldens` / Flutter widget goldens** — Flutter-specific; out of scope for
  a plain-Dart extension. Worth adding as a separate `flutter_test` tool if/when this gets a
  Flutter-aware sibling.
- **Mutating `dart pub` commands** (`get`, `upgrade`) — better left to explicit shell commands
  than agent-invoked tools, same reasoning pi-moonbit applies to not exposing `moon add`/`moon install`.

## Suggested sequencing

1. Edit source
2. `dart_analyze` with a low `diagnosticLimit` first (cheap first-error check)
3. `dart_analyze` full pass
4. `dart_test` (once analyze is clean)
5. `dart_fix` dry-run — review before `apply: true`
6. `build_runner` if the project uses code generation and generated files are stale
