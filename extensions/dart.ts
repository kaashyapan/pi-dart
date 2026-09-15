// Pi extension: wraps `dart analyze`, `dart test`, `dart fix`, and
// `dart run build_runner build` as discrete tools so the model gets
// summarized, token-efficient feedback instead of raw compiler/test/build
// log text. Place this file (with its siblings doctor.ts and dartexec.ts)
// in `.pi/extensions/` (project-local) or `~/.pi/agent/extensions/`
// (global).
//
// Modeled on kaashyapan/pi-moonbit's moonbit.ts, including its file layout
// (exec/timeout plumbing and the toolchain check split into sibling modules
// rather than inlined here). Design notes carried over:
// - One tool per CLI intent rather than one tool with a `command` enum —
//   each intent has a different useful parameter shape, and separate tools
//   give the model clearer selection signal.
// - Output is truncated defensively (MAX_OUTPUT_CHARS) — dart_analyze and
//   build_runner can both produce large output on a big project.
// - The `dart` binary is checked (`dart --version`) once at extension load.
//   All tools below are registered ONLY if that check succeeds — a tool that
//   always fails with "command not found" is worse than not having the tool
//   at all, since the model will keep retrying it or misdiagnose the failure
//   as a code problem. The always-registered `dart-doctor` command lets a
//   human re-check reachability (e.g. after fixing PATH) without needing to
//   know in advance that's what's wrong.
// - All tool execute handlers pass `ctx.cwd` (or a `path` under it) into
//   subprocesses so they run in the right project/package root.
// - AbortSignal is honoured via execFile's own `signal` option (see dartexec.ts).
// - Bash calls that duplicate a registered tool are hard-blocked via a
//   `tool_call` event handler — see "bash → tool redirection" below.
//
// pi-coding-agent API notes (verified against the installed runner, which
// differ from pi-moonbit's older assumptions):
// - execute() return values have NO isError field; returning a normal result
//   never marks a tool result as an error, and throwing would *replace* the
//   summarized content with the raw exception text. The tool_result hook
//   (pi.on("tool_result", ...)) is the supported seam for flagging
//   failures: its return value can override content/details/isError on the
//   outgoing tool-result message, so the model still sees the full parsed
//   summary AND gets the error framing. All four tools set a
//   `flagsDiagnosticFailure` marker in details when the outcome should be
//   treated as an error; the hook translates that marker.
// - execute() throwing is reserved for genuine crashes (the runtime catches
//   it and surfaces "message" as the whole tool result).
//
// Deliberately left out, same reasoning pi-moonbit applies to `moon build`/
// `moon add`: LSP-style navigation (definition/hover/references/rename) is
// left to pi-lens, which already ships a built-in Dart LSP client with
// process-lifecycle/document-sync/cancellation handling this extension would
// otherwise have to re-solve for no benefit. `build_runner watch` is
// long-running and not a fit for a one-shot tool call. Mutating `dart pub`
// commands (get/upgrade) are left to explicit shell commands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkDartAvailable } from "./doctor";
import { runDart } from "./dartexec";

const MAX_OUTPUT_CHARS = 20_000;
const TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;
const BUILD_RUNNER_TIMEOUT_MS = 300_000;

// Set on every tool result whose outcome should be presented to the model as
// an error (diagnostics errors, failing tests, failed build) without losing
// the summarized content. Translated by the tool_response hook below.
const FAILURE_FLAG = "flagsDiagnosticFailure";

// --- bash → tool redirection ------------------------------------------------
// Tool descriptions are only a soft nudge — models reach for `bash` anyway
// since it feels more familiar/flexible than picking the "right" tool. The
// `tool_call` event fires before a tool executes and can block it, which
// turns the nudge into a hard rule: if the model tries to run a `dart`
// subcommand we have a dedicated tool for, the bash call is blocked and the
// reason names the tool to use instead. This is only registered once the
// dart_* tools themselves are active (see the startupCheck gate below) —
// blocking bash with no working replacement would just strand the model.
//
// Matching is deliberately conservative, following pi-moonbit's
// bash-redirect.ts: quoted segments are stripped and patterns are only
// tested at shell command positions (start of a segment or after ;, &&, ||,
// |, $(), backticks). A command that merely *mentions* `dart test` —
// `echo "dart test"`, `grep 'dart analyze' notes.md` — must pass through to
// bash untouched. The tradeoff is that prefixed invocations like `sudo dart
// test` won't redirect.

interface BashRedirect {
	match: RegExp;
	tool: string;
	note: string;
}

// Patterns are anchored to a command position; findBashRedirect applies
// them per separator-split segment, not to the raw command string.
const BASH_REDIRECTS: BashRedirect[] = [
	{
		match: /^dart\s+analyze\b/,
		tool: "dart_analyze",
		note: "it parses --format=machine output into a summarized diagnostics list grouped by file and accepts `path`/`diagnosticLimit` to scope it.",
	},
	{
		match: /^dart\s+test\b/,
		tool: "dart_test",
		note: "it parses the JSON reporter stream into pass/fail counts with failure details, and accepts `path`, `name`, or `platform` instead of flags.",
	},
	{
		match: /^dart\s+fix\b/,
		tool: "dart_fix",
		note: "it dry-runs by default and only rewrites files when called with apply: true.",
	},
	{
		match: /^dart\s+run\s+build_runner\s+build\b/,
		tool: "build_runner",
		note: "it filters the noisy builder log down to warnings/errors plus the final succeeded/failed summary.",
	},
	// Deliberately no entry for `build_runner watch` — there's no dedicated
	// tool for it (long-running, not a fit for a one-shot call), so bash
	// remains the right way to run it. Blocking with no replacement would
	// just strand the model.
];

// Removes single/double-quoted segments (content, not just delimiters) so
// string arguments never influence the match. Unbalanced quotes degrade to
// fail-open (the remainder is dropped), which is the safe direction here.
function stripQuotedSegments(command: string): string {
	let out = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++; // skip the escaped char
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += " "; // keep token separation
			continue;
		}
		out += ch;
	}
	return out;
}

export function findBashRedirect(command: string): BashRedirect | undefined {
	const unquoted = stripQuotedSegments(command);
	const segments = unquoted.split(/[;&|()`]|\$\(|\n/).map((s) => s.trim());
	// First matching segment wins (leftmost command in the chain), then the
	// redirect table order breaks ties within a segment.
	for (const segment of segments) {
		const redirect = BASH_REDIRECTS.find((r) => r.match.test(segment));
		if (redirect) return redirect;
	}
	return undefined;
}

// --- shared helpers --------------------------------------------------------

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT_CHARS) return s;
	return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

function resolveCwd(ctxCwd: string, path?: string): string {
	if (!path) return ctxCwd;
	return path.startsWith("/") ? path : `${ctxCwd}/${path}`;
}

// Uniform result builder: failures carry the FAILURE_FLAG in details so the
// tool_response hook can set isError on the outgoing message.
function result(text: string, details: Record<string, unknown>, failed: boolean) {
	return {
		content: [{ type: "text" as const, text: truncate(text) }],
		details: failed ? { ...details, [FAILURE_FLAG]: true } : details,
	};
}

// --- dart_analyze --------------------------------------------------------
// `dart analyze --format=machine` writes pipe-delimited diagnostics to
// stdout, one per line, with `|`, `\`, and newlines backslash-escaped
// (verified on SDK 3.13: `WARNING|STATIC_WARNING|CODE|file|line|col|len|msg`).
// Exit codes: 0 clean, 2 warnings/lints/infos, 3+ errors. Non-zero exit is a
// normal outcome — only diagnostics with severity ERROR flag the call as a
// failure. Any line that doesn't match (banners, stray chatter) parses to
// null and is filtered, so scanning stderr too costs nothing.

interface Diagnostic {
	severity: string;
	type: string;
	code: string;
	file: string;
	line: number;
	col: number;
	length: number;
	message: string;
}

function splitEscaped(s: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length) {
			cur += s[i] + s[i + 1];
			i++;
		} else if (s[i] === sep) {
			out.push(cur);
			cur = "";
		} else {
			cur += s[i];
		}
	}
	out.push(cur);
	return out;
}

function unescapeField(s: string): string {
	return s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
}

export function parseAnalyzeMachineLine(line: string): Diagnostic | null {
	if (!line.trim()) return null;
	const parts = splitEscaped(line, "|");
	if (parts.length < 8) return null;
	const [severity, type, code, file, lineNo, col, length, ...rest] = parts;
	if (!/^(ERROR|WARNING|INFO)$/.test(severity)) return null;
	if (!Number.isFinite(Number(lineNo)) || !Number.isFinite(Number(col))) return null;
	return {
		severity,
		type,
		code,
		file: unescapeField(file),
		line: Number(lineNo),
		col: Number(col),
		length: Number(length),
		message: unescapeField(rest.join("|")),
	};
}

export function summarizeAnalyze(diagnostics: Diagnostic[], limit: number): string {
	if (diagnostics.length === 0) return "No issues found.";

	const byFile = new Map<string, Diagnostic[]>();
	for (const d of diagnostics) {
		if (!byFile.has(d.file)) byFile.set(d.file, []);
		byFile.get(d.file)!.push(d);
	}

	const errorCount = diagnostics.filter((d) => d.severity === "ERROR").length;
	const warningCount = diagnostics.filter((d) => d.severity === "WARNING").length;
	const infoCount = diagnostics.length - errorCount - warningCount;

	const lines: string[] = [
		`${diagnostics.length} issue(s): ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info/lint(s).`,
		"",
	];

	let shown = 0;
	outer: for (const [file, diags] of byFile) {
		lines.push(file);
		for (const d of diags) {
			if (shown >= limit) {
				lines.push(`  … +${diagnostics.length - shown} more (raise diagnosticLimit to see all)`);
				break outer;
			}
			lines.push(`  ${d.line}:${d.col} [${d.severity}/${d.type}] ${d.code}: ${d.message}`);
			shown++;
		}
	}

	return lines.join("\n");
}

function registerDartAnalyze(pi: ExtensionAPI) {
	pi.registerTool({
		name: "dart_analyze",
		label: "Dart: Analyze",
		description:
			"Dart: Analyze - Run `dart analyze` over the whole project (or a package/dir) and return a summarized diagnostics list grouped by file. Run this after edits and before dart_test — cheaper than a build and catches errors early. Non-zero exit is normal (issues found); only real errors (not warnings/lints) mark the result as failed.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory or package to analyze, relative to cwd. Defaults to the whole project." })),
			diagnosticLimit: Type.Optional(
				Type.Number({ description: "Cap on diagnostics shown before truncating with a '+N more' note. Default 50." }),
			),
		}),
		promptGuidelines: [
			"Follow this sequence",
			"1. Edit source",
			"2. `dart_analyze` with a low diagnosticLimit first (cheap first-error check)",
			"3. `dart_analyze` full pass",
			"4. `dart_test` once analyze is clean",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = resolveCwd(ctx.cwd, params.path);
			const limit = params.diagnosticLimit ?? 50;

			const r = await runDart(["analyze", "--format=machine", "."], { cwd, signal, timeout: TIMEOUT_MS });

			if (r.aborted) {
				return result("Cancelled.", { ok: false, aborted: true }, true);
			}
			if (r.spawnFailed) {
				return result(`Failed to run dart analyze: ${r.spawnMessage}\nstderr: ${r.stderr}`, { ok: false }, true);
			}
			if (r.timedOut) {
				return result(`dart analyze timed out after ${TIMEOUT_MS / 1000}s.`, { ok: false, timedOut: true }, true);
			}

			const diagnostics = [...r.stdout.split("\n"), ...r.stderr.split("\n")]
				.map(parseAnalyzeMachineLine)
				.filter((d): d is Diagnostic => d !== null);

			const errors = diagnostics.filter((d) => d.severity === "ERROR");
			const summary = summarizeAnalyze(diagnostics, limit);

			return result(summary, {
				ok: true,
				issueCount: diagnostics.length,
				errorCount: errors.length,
				warningCount: diagnostics.length - errors.length,
				hasErrors: errors.length > 0,
			}, errors.length > 0);
		},
	});
}

// --- dart_test -----------------------------------------------------------
// `dart test -r json` emits NDJSON on stdout, one event per line (verified
// against package:test 1.32 / SDK 3.13). Non-zero exit (failed tests, exit 1;
// no tests found, exit 79) is a normal process outcome — only genuine spawn
// failures are execution errors. Failed tests still flag the result as a
// failure so the model treats them as something to fix, same rationale as
// moon_test.
//
// Counting rules learned from the real stream:
// - `testDone` events with `"hidden": true` are loader bookkeeping ("loading
//   test/foo_test.dart") and must be skipped, or every run double-counts.
// - Compile errors surface as a non-hidden `testDone` with result "error"
//   plus a matching `error` event whose `isFailure` is false — count them as
//   failures (nothing passed) and surface the compile error text.
// - skipped tests arrive as result "success" with skipped: true.

export function summarizeTestEvents(ndjson: string): {
	summary: string;
	passed: number;
	failed: number;
	skipped: number;
} {
	const testNames = new Map<number, string>();
	const errors = new Map<number, { message: string; stackTrace: string }>();
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	let suiteError: string | null = null;

	for (const line of ndjson.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue; // tolerate stray non-JSON lines
		}

		switch (event.type) {
			case "testStart":
				if (event.test?.id != null) testNames.set(event.test.id, event.test.name);
				break;
			case "testDone":
				if (event.hidden === true) break; // loader bookkeeping, not a test
				if (event.skipped) skipped++;
				else if (event.result === "success") passed++;
				else failed++; // "failure" and "error" (compile errors) both land here
				break;
			case "error":
				errors.set(event.testID, {
					message: String(event.error ?? "").slice(0, 500),
					stackTrace: String(event.stackTrace ?? "").split("\n").slice(0, 3).join("\n"),
				});
				break;
			case "done":
				if (event.success === false && passed === 0 && failed === 0) {
					suiteError = "Test run did not complete successfully (compile error or setup failure — see stderr).";
				}
				break;
		}
	}

	const lines: string[] = [`${passed} passed, ${failed} failed, ${skipped} skipped.`];
	if (suiteError) lines.push(suiteError);

	if (failed > 0 && errors.size > 0) {
		lines.push("", "Failures:");
		for (const [testID, err] of errors) {
			const name = testNames.get(testID) ?? `test #${testID}`;
			lines.push(`  ${name}`, `    ${err.message.replace(/\n/g, "\n    ")}`);
			if (err.stackTrace) lines.push(`    ${err.stackTrace.replace(/\n/g, "\n    ")}`);
		}
	}

	return { summary: lines.join("\n"), passed, failed, skipped };
}

function registerDartTest(pi: ExtensionAPI) {
	pi.registerTool({
		name: "dart_test",
		label: "Dart: Test",
		description:
			"Dart: Test - Run `dart test` and return a summarized pass/fail count plus failure details, not the full event stream. Prefer dart_analyze first (cheaper). Failing tests mark the result as failed so the model treats them as something to fix.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Test file or directory to run, relative to cwd." })),
			name: Type.Optional(Type.String({ description: "Plain-name substring filter for tests (passed to --plain-name). Regex needs escaping; prefer plain names." })),
			platform: Type.Optional(Type.String({ description: "Platform to run on (vm, chrome, node, ...), passed to -p." })),
		}),
		promptGuidelines: ["Test should only be run against a package/dir in which files have been edited, once dart_analyze is clean."],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = ["test", "-r", "json"];
			// --name is regex-flavored; --plain-name does substring matching,
			// which is almost always what a model means by "name".
			if (params.name) args.push("--plain-name", params.name);
			if (params.platform) args.push("-p", params.platform);
			if (params.path) args.push(params.path);

			const r = await runDart(args, { cwd: ctx.cwd, signal, timeout: TEST_TIMEOUT_MS });

			if (r.aborted) {
				return result("Cancelled.", { ok: false, aborted: true }, true);
			}
			if (r.spawnFailed) {
				return result(`Failed to run dart test: ${r.spawnMessage}\nstderr: ${r.stderr}`, { ok: false }, true);
			}
			if (r.timedOut) {
				return result(`dart test timed out after ${TEST_TIMEOUT_MS / 1000}s.`, { ok: false, timedOut: true }, true);
			}

			const { summary, passed, failed, skipped } = summarizeTestEvents(r.stdout);
			// Exit 79 = "no tests ran" (e.g. the name filter matched nothing).
			// Surface the real reason instead of a bare "0 passed, 0 failed".
			const noTests = r.exitCode === 79 || (r.exitCode !== 0 && failed === 0 && passed === 0);
			const stderrNote = r.stderr.trim() ? `\nstderr:\n${r.stderr.trim()}` : "";
			const text = noTests
				? `No tests ran (exit 79).${stderrNote || "\nCheck the path/name filter — it matched nothing."}${r.stdout.trim() ? `\n${r.stdout.trim().slice(0, 2000)}` : ""}`
				: summary + stderrNote;

			return result(text, {
				ok: !noTests && failed === 0,
				passed,
				failed,
				skipped,
				exitCode: r.exitCode,
			}, !noTests && failed > 0);
		},
	});
}

// --- dart_fix --------------------------------------------------------------
// Dry-runs by default. The model must explicitly set apply: true to rewrite
// files, and we still show the computed summary either way so it's an
// informed decision, not a blind flag flip — same posture as moon_rename.
//
// `dart fix` has no --format=json, so this is a best-effort text
// summarizer pinned to SDK 3.13's real output shape (verified):
//
//   Computing fixes in dartprobe (dry run)...
//
//   3 proposed fixes in 2 files.
//
//   lib/fixA.dart
//     duplicate_import - 1 fix
//     unused_import - 1 fix
//
//   lib/fixB.dart
//     unnecessary_this - 1 fix
//
//   To fix an individual diagnostic, run one of:
//     dart fix --apply --code=duplicate_import
//     ...
//
//   To fix all diagnostics, run:
//     dart fix --apply
//
// ("Applying fixes..." / "N fix(es) made in N file(s)." on --apply;
// "Nothing to fix!" when clean.) The regexes below capture the count line,
// the per-file code/fix lines, and the final made/proposed line. If your SDK
// words things differently, the summarizer falls back to a capped raw
// excerpt rather than dropping information silently.

export function summarizeFixOutput(text: string): string {
	const lines = text.split("\n");
	const summaryLines: string[] = [];
	let matchedAnything = false;

	const countLineRe = /^\s*\d+\s+(proposed\s+)?fix(es)?\b/i;
	const perFileCodeRe = /^\s{2}\S.*\s-\s\d+\s+fix(es)?$/;
	const fileHeaderRe = /^\s*\S+\.dart$/;
	const finalLineRe = /\bfix(es)?\b.*\b(made|proposed)\b/i;

	for (const line of lines) {
		if (countLineRe.test(line) || perFileCodeRe.test(line) || fileHeaderRe.test(line) || finalLineRe.test(line)) {
			summaryLines.push(line.replace(/\s+$/, ""));
			matchedAnything = true;
		}
	}

	if (matchedAnything) return summaryLines.join("\n");

	const capped = lines.slice(0, 60).join("\n");
	return lines.length > 60 ? `${capped}\n… (${lines.length - 60} more lines, output format not recognized)` : capped;
}

function registerDartFix(pi: ExtensionAPI) {
	pi.registerTool({
		name: "dart_fix",
		label: "Dart: Fix",
		description:
			"Dart: Fix - Preview or apply automated analyzer-driven fixes. Defaults to a dry run (returns the proposed-fix summary without writing). Set apply: true only after reviewing the dry-run output, since this rewrites files on disk.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory to fix, relative to cwd. Defaults to the whole project." })),
			apply: Type.Optional(Type.Boolean({ description: "If true, rewrite files. Defaults to false (dry run)." })),
		}),
		promptGuidelines: ["Prefer dart_fix dry-run over hand-editing lint fixes; apply only after reviewing the proposal."],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = resolveCwd(ctx.cwd, params.path);
			const apply = params.apply === true;
			const args = ["fix", apply ? "--apply" : "--dry-run"];
			if (params.path) args.push(params.path);

			const r = await runDart(args, { cwd, signal, timeout: TIMEOUT_MS });

			if (r.aborted) {
				return result("Cancelled.", { ok: false, aborted: true }, true);
			}
			if (r.spawnFailed) {
				return result(`Failed to run dart fix: ${r.spawnMessage}\nstderr: ${r.stderr}`, { ok: false }, true);
			}
			if (r.timedOut) {
				return result(`dart fix timed out after ${TIMEOUT_MS / 1000}s.`, { ok: false, timedOut: true }, true);
			}

			const prefix = apply ? "[APPLIED]\n" : "[DRY RUN — no files written; call again with apply: true to rewrite]\n";
			const summary = summarizeFixOutput(r.stdout);
			const stderrNote = r.stderr.trim() ? `\nstderr:\n${r.stderr.trim()}` : "";

			return result(prefix + summary + stderrNote, {
				ok: r.exitCode === 0,
				apply,
				exitCode: r.exitCode,
			}, r.exitCode !== 0);
		},
	});
}

// --- build_runner ------------------------------------------------------
// build_runner's default log is very noisy (one line per builder per file).
// Real output shape (verified on build_runner 2.10.x / SDK 3.13, note the
// two-space indent — older builds used "[SEVERE]"/"[WARNING]" prefixes and
// "Succeeded after"; this version uses "E"/"W" level prefixes and
// "Built with build_runner/aot in Ns" / "Failed to build with ..."):
//
//     0s dart_probe:copy_builder on 1 input; lib/model.dart
//   E dart_probe:copy_builder on lib/model.dart:
//     Bad state: boom severe failure
//     ...
//     Failed to build with build_runner/aot in 0s; wrote 0 outputs.
//
// Filter stdout and stderr independently down to E/W lines plus the final
// Built/Failed summary, capped at 60 lines. Falls back to the last 20 lines
// of stdout if nothing matches (a clean run with no warnings still needs
// some confirmation shown).

export function filterBuildRunnerLines(text: string): string[] {
	return text
		.split("\n")
		.filter(
			(l) =>
				/^(E|W) /.test(l) || // "E builder on file:" / "W ..." level lines (real shape)
				/^  [EW] /.test(l) || // indented variant, defensive
				/\[SEVERE\]|\[WARNING\]/.test(l) || // older build_runner format
				/Built with build_runner|Failed to build with|Succeeded after|Failed after/.test(l),
		);
}

export function summarizeBuildRunnerOutput(stdout: string, stderr: string): string {
	const interesting = [...filterBuildRunnerLines(stdout), ...filterBuildRunnerLines(stderr)];
	if (interesting.length === 0) {
		// Nothing severe/warning and no summary line matched — fall back to the
		// tail of both streams, since build_runner's most useful line is usually
		// its last (and fatal setup errors go to stderr).
		const tail = [...stdout.split("\n").slice(-20), ...stderr.split("\n").slice(-20)]
			.filter((l) => l.trim())
			.join("\n");
		return tail || "(no output)";
	}
	const capped = interesting.slice(0, 60);
	const note = interesting.length > 60 ? `\n… +${interesting.length - 60} more log lines omitted` : "";
	return capped.join("\n") + note;
}

function registerBuildRunner(pi: ExtensionAPI) {
	pi.registerTool({
		name: "build_runner",
		label: "Dart: Build Runner",
		description:
			"Dart: Build Runner - Run `dart run build_runner build` (code generation for freezed/json_serializable/etc.) and return a filtered log — only error/warning lines and the final succeeded/failed summary, not the full noisy builder log. Does not expose watch mode (long-running, not a fit for a one-shot tool call).",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Package directory to run in, relative to cwd." })),
			deleteConflictingOutputs: Type.Optional(Type.Boolean({ description: "Pass --delete-conflicting-outputs. Default false." })),
		}),
		promptGuidelines: ["Run build_runner after editing @annotations/freezed classes or changing build.yaml; check generated *.g.dart files are current before dart_test."],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = resolveCwd(ctx.cwd, params.path);
			const args = ["run", "build_runner", "build"];
			if (params.deleteConflictingOutputs) args.push("--delete-conflicting-outputs");

			const r = await runDart(args, { cwd, signal, timeout: BUILD_RUNNER_TIMEOUT_MS });

			if (r.aborted) {
				return result("Cancelled.", { ok: false, aborted: true }, true);
			}
			if (r.spawnFailed) {
				return result(`Failed to run build_runner: ${r.spawnMessage}\nstderr: ${r.stderr}`, { ok: false }, true);
			}
			if (r.timedOut) {
				return result(`build_runner timed out after ${BUILD_RUNNER_TIMEOUT_MS / 1000}s.`, { ok: false, timedOut: true }, true);
			}

			const summary = summarizeBuildRunnerOutput(r.stdout, r.stderr);
			return result(summary, { ok: r.exitCode === 0, exitCode: r.exitCode }, r.exitCode !== 0);
		},
	});
}

// --- extension entry point -----------------------------------------------

export default async function (pi: ExtensionAPI) {
	const startupCheck = await checkDartAvailable();

	// Always registered, regardless of toolchain state, so a human can
	// diagnose *why* the dart_* tools are missing (or confirm they're live)
	// without needing to know in advance that this extension gates on PATH.
	pi.registerCommand("dart-doctor", {
		description: "Dart doctor: check whether the Dart SDK is reachable on PATH and whether the dart_* tools are active.",
		handler: async (_args, ctx) => {
			const result = await checkDartAvailable(ctx.cwd);
			if (result.available) {
				const toolsLive = startupCheck.available;
				ctx.ui.notify(
					`dart is reachable — ${result.version}. ` +
						(toolsLive
							? "Dart tools (dart_analyze, dart_test, dart_fix, build_runner) are active."
							: "Dart tools were NOT registered at startup (dart wasn't reachable then). Run /reload to pick them up now."),
					"info",
				);
			} else {
				ctx.ui.notify(
					`dart is not reachable: ${result.error}. Install the Dart SDK or fix PATH, then run /dart-doctor again (or /reload) once fixed. Dart tools are not registered.`,
					"error",
				);
			}
		},
	});

	// Translate the tools' FAILURE_FLAG markers into isError on the outgoing
	// tool-result message. Registered unconditionally: before the tools exist
	// it matches nothing, and after /reload brings them online it's already in
	// place. The model keeps the full summarized content AND gets proper error
	// framing, which the execute() return value alone cannot express.
	pi.on("tool_result", (event) => {
		const details = event.details as Record<string, unknown> | undefined;
		if (!details || details[FAILURE_FLAG] !== true) return;
		return {
			details: { ...details, [FAILURE_FLAG]: undefined },
			isError: true,
		};
	});

	if (!startupCheck.available) {
		// Do not register any dart_* tools when the toolchain isn't functional —
		// an always-failing tool is worse than no tool. Use /dart-doctor to
		// re-check after fixing PATH, then /reload to register them.
		return;
	}

	// Hard-block bash calls that duplicate a registered dart_* tool. Fires
	// before the bash tool executes; returning { block: true, reason } stops
	// it and surfaces `reason` to the model in place of a result, so it
	// self-corrects to the named tool on the next turn instead of getting a
	// normal (successful) bash result that reinforces the bash habit.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		const redirect = findBashRedirect(command);
		if (!redirect) return;
		return {
			block: true,
			reason: `Use the ${redirect.tool} tool instead of running this via bash — ${redirect.note}`,
		};
	});

	registerDartAnalyze(pi);
	registerDartTest(pi);
	registerDartFix(pi);
	registerBuildRunner(pi);
}
