// Tests for the tools registered by extensions/dart.ts (the pi Dart
// extension). Strategy mirrors pi-moonbit's suite:
//
// 1. Unit tests for the pure helpers (parseAnalyzeMachineLine,
//    summarizeTestEvents, summarizeFixOutput, filterBuildRunnerLines,
//    findBashRedirect) using output captured from real SDK 3.13 /
//    package:test 1.32 / build_runner 2.10 runs.
// 2. Integration tests that load the real extension into a stub
//    ExtensionAPI and execute the actual tool handlers against the fixture
//    packages in fixtures/dart-sample (warnings + pass/fail/skip tests) and
//    fixtures/dart-broken (a compile error, kept in a separate package so it
//    can't poison passing dart_test runs).
//
// Error-flag semantics note: the installed pi runtime's execute() results
// carry no isError field — failures are flagged via the extension's
// tool_result hook translating the FAILURE_FLAG marker in details. The
// integration tests assert on that marker (details[FAILURE_FLAG]), which is
// exactly what the model-facing hook keys off.

import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dartExtension, {
	findBashRedirect,
	parseAnalyzeMachineLine,
	summarizeAnalyze,
	summarizeTestEvents,
	summarizeFixOutput,
	filterBuildRunnerLines,
	summarizeBuildRunnerOutput,
	unresolvedProjectHint,
} from "../extensions/dart.ts";
import { checkDartAvailable } from "../extensions/doctor.ts";
import { runDart } from "../extensions/dartexec.ts";

export const FAILURE_FLAG = "flagsDiagnosticFailure";

// ---------------------------------------------------------------------------
// Harness: stub ExtensionAPI that captures registrations
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(import.meta.dir, "../fixtures/dart-sample");
const BROKEN_DIR = path.resolve(import.meta.dir, "../fixtures/dart-broken");

const tools = new Map<string, any>();
const commands = new Map<string, any>();
const listeners = new Map<string, (event: any) => any>();

function makeStubPi() {
	return {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, spec: any) => commands.set(name, spec),
		on: (event: string, handler: (event: any) => any) => listeners.set(event, handler),
	};
}

async function execute(
	name: string,
	params: Record<string, unknown>,
	ctx: { cwd?: string } = {},
) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return await tool.execute("test-call-id", params, undefined, undefined, ctx);
}

beforeAll(async () => {
	// Load the full extension (doctor command + tool suite) through the real
	// default export; registration runs the `dart --version` reachability
	// check, which must pass for the integration tests below anyway.
	await dartExtension(makeStubPi() as any);
});

// ---------------------------------------------------------------------------
// Pure helpers — dart_analyze machine format
// ---------------------------------------------------------------------------

// Real lines captured via `dart analyze --format=machine` (SDK 3.13.2).
const REAL_WARNING_LINE =
	'WARNING|STATIC_WARNING|UNUSED_LOCAL_VARIABLE|/tmp/dartprobe/lib/math.dart|5|7|9|The value of the local variable \'unusedVar\' isn\'t used.';
const REAL_ERROR_LINE =
	"ERROR|COMPILE_TIME_ERROR|RETURN_OF_INVALID_TYPE|/tmp/dartprobe/lib/broken.dart|2|10|12|A value of type 'String' can't be returned from the function 'broken' because it has a return type of 'int'.";

describe("parseAnalyzeMachineLine", () => {
	test("parses real diagnostic lines", () => {
		const warn = parseAnalyzeMachineLine(REAL_WARNING_LINE);
		expect(warn).not.toBeNull();
		expect(warn!.severity).toBe("WARNING");
		expect(warn!.type).toBe("STATIC_WARNING");
		expect(warn!.code).toBe("UNUSED_LOCAL_VARIABLE");
		expect(warn!.file).toBe("/tmp/dartprobe/lib/math.dart");
		expect(warn!.line).toBe(5);
		expect(warn!.col).toBe(7);
		expect(warn!.message).toContain("unusedVar");

		const err = parseAnalyzeMachineLine(REAL_ERROR_LINE);
		expect(err!.severity).toBe("ERROR");
		expect(err!.code).toBe("RETURN_OF_INVALID_TYPE");
	});

	test("unescapes backslash-escaped fields", () => {
		// analyzer escapes |, \, and newlines in message text
		const line = "WARNING|STATIC_WARNING|X|f.dart|1|1|1|pipe \\| backslash \\\\ newline \\n end";
		const d = parseAnalyzeMachineLine(line);
		expect(d!.message).toBe("pipe | backslash \\ newline \n end");
	});

	test("keeps | inside the message by rejoining the tail", () => {
		const line = "INFO|LINT|SOME_LINT|f.dart|1|1|1|a|b|c";
		const d = parseAnalyzeMachineLine(line);
		expect(d!.message).toBe("a|b|c");
	});

	test("rejects non-diagnostic lines", () => {
		expect(parseAnalyzeMachineLine("")).toBeNull();
		expect(parseAnalyzeMachineLine("Analyzing dartprobe...")).toBeNull();
		expect(parseAnalyzeMachineLine("No issues found!")).toBeNull();
		expect(parseAnalyzeMachineLine("TOO|FEW|FIELDS")).toBeNull();
		expect(parseAnalyzeMachineLine("BADSEVERITY|T|C|f.dart|1|1|1|msg")).toBeNull();
		expect(parseAnalyzeMachineLine("WARNING|STATIC_WARNING|C|f.dart|NaN|1|1|msg")).toBeNull();
	});
});

describe("summarizeAnalyze", () => {
	const two = [
		parseAnalyzeMachineLine(REAL_ERROR_LINE)!,
		parseAnalyzeMachineLine(REAL_WARNING_LINE)!,
	];

	test("clean report", () => {
		expect(summarizeAnalyze([], 50)).toBe("No issues found.");
	});

	test("counts by severity and groups by file", () => {
		const s = summarizeAnalyze(two, 50);
		expect(s).toContain("2 issue(s): 1 error(s), 1 warning(s), 0 info/lint(s).");
		expect(s).toContain("/tmp/dartprobe/lib/broken.dart");
		expect(s).toContain("[ERROR/COMPILE_TIME_ERROR] RETURN_OF_INVALID_TYPE");
	});

	test("respects the limit with a +N more note", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({
			severity: "WARNING",
			type: "STATIC_WARNING",
			code: `C${i}`,
			file: "a.dart",
			line: i + 1,
			col: 1,
			length: 1,
			message: `m${i}`,
		}));
		const s = summarizeAnalyze(many, 2);
		expect(s).toContain("+3 more");
	});
});

// ---------------------------------------------------------------------------
// Pure helpers — fresh-checkout (pub get not run) detection
// ---------------------------------------------------------------------------

// Real machine-format lines captured from `dart analyze --format=machine` on
// a freshly bootstrapped project with .dart_tool and pubspec.lock removed:
// every package: import fails to resolve and every symbol from those
// packages is undefined.
const FRESH_CHECKOUT_LINES = [
	"ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/tmp/dart-fresh/test/dart_fresh_test.dart|1|8|36|Target of URI doesn't exist: 'package:dart_fresh/dart_fresh.dart'.",
	"ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/tmp/dart-fresh/test/dart_fresh_test.dart|2|8|24|Target of URI doesn't exist: 'package:test/test.dart'.",
	"ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/tmp/dart-fresh/example/dart_fresh_example.dart|1|8|36|Target of URI doesn't exist: 'package:dart_fresh/dart_fresh.dart'.",
	"ERROR|COMPILE_TIME_ERROR|UNDEFINED_FUNCTION|/tmp/dart-fresh/test/dart_fresh_test.dart|5|3|5|The function 'group' isn't defined.",
	"ERROR|COMPILE_TIME_ERROR|UNDEFINED_FUNCTION|/tmp/dart-fresh/test/dart_fresh_test.dart|9|5|5|The function 'test' isn't defined.",
	"ERROR|COMPILE_TIME_ERROR|UNDEFINED_CLASS|/tmp/dart-fresh/example/dart_fresh_example.dart|4|17|7|The function 'Awesome' isn't defined.",
].map((l) => parseAnalyzeMachineLine(l)!);

// One genuinely broken import (a typo) alongside real code errors — the
// case where the hint must NOT fire, because these need fixing in code.
const MIXED_SIGNAL_LINES = [
	"ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/tmp/real/lib/a.dart|1|8|30|Target of URI doesn't exist: 'package:typo/wrong.dart'.",
	"ERROR|COMPILE_TIME_ERROR|RETURN_OF_INVALID_TYPE|/tmp/real/lib/b.dart|2|10|12|A value of type 'String' can't be returned from the function 'broken' because it has a return type of 'int'.",
	"ERROR|COMPILE_TIME_ERROR|INVALID_CAST|/tmp/real/lib/c.dart|8|12|4|This cast is always invalid.",
].map((l) => parseAnalyzeMachineLine(l)!);

describe("unresolvedProjectHint", () => {
	test("fires on a fresh-checkout report and names the missing packages", () => {
		const hint = unresolvedProjectHint(FRESH_CHECKOUT_LINES);
		expect(hint).toBeDefined();
		expect(hint).toContain("6 of 6 diagnostics");
		expect(hint).toContain("dart pub get");
		expect(hint).toContain("dart_fresh, test");
	});

	test("mentions unrelated diagnostics when some are not resolution-related", () => {
		const lines = [
			...FRESH_CHECKOUT_LINES,
			parseAnalyzeMachineLine(
				"ERROR|COMPILE_TIME_ERROR|INVALID_CAST|/tmp/dart-fresh/lib/x.dart|3|1|4|This cast is always invalid.",
			)!,
		];
		const hint = unresolvedProjectHint(lines);
		expect(hint).toBeDefined();
		expect(hint).toContain("1 diagnostic(s) are unrelated");
	});

	test("does not fire on mixed signal (one typo'd import among real errors)", () => {
		expect(unresolvedProjectHint(MIXED_SIGNAL_LINES)).toBeUndefined();
	});

	test("does not fire on ordinary errors with no package-URI failures", () => {
		expect(unresolvedProjectHint([parseAnalyzeMachineLine(REAL_ERROR_LINE)!])).toBeUndefined();
	});

	test("does not fire on an empty report", () => {
		expect(unresolvedProjectHint([])).toBeUndefined();
	});

	test("caps the missing-package list at five", () => {
		const lines = Array.from({ length: 10 }, (_, i) =>
			parseAnalyzeMachineLine(
				`ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/tmp/x/f${i}.dart|1|8|30|Target of URI doesn't exist: 'package:pkg${i}/lib${i}.dart'.`,
			)!,
		);
		const hint = unresolvedProjectHint(lines);
		expect(hint).toBeDefined();
		expect(hint).toContain("pkg0, pkg1, pkg2, pkg3, pkg4, …");
		expect(hint).not.toContain("pkg9");
	});
});

// ---------------------------------------------------------------------------
// Pure helpers — dart_test JSON reporter
// ---------------------------------------------------------------------------

// Real event stream captured via `dart test -r json` on the fixture
// (package:test 1.32.0): hidden loader testDone, pass, failure, skip.
const REAL_TEST_STREAM = [
	'{"protocolVersion":"0.1.1","runnerVersion":"1.32.0","pid":1,"type":"start","time":0}',
	'{"suite":{"id":0,"platform":"vm","path":"test/math_test.dart"},"type":"suite","time":0}',
	'{"test":{"id":1,"name":"loading test/math_test.dart","suiteID":0,"groupIDs":[],"metadata":{"skip":false,"skipReason":null},"line":null,"column":null,"url":null},"type":"testStart","time":0}',
	'{"test":{"id":3,"name":"add works","suiteID":0,"groupIDs":[2],"metadata":{"skip":false,"skipReason":null},"line":5,"column":3,"url":"file:///t/test/math_test.dart"},"type":"testStart","time":1}',
	'{"test":{"id":4,"name":"intentionally failing","suiteID":0,"groupIDs":[2],"metadata":{"skip":false,"skipReason":null},"line":9,"column":3,"url":"file:///t/test/math_test.dart"},"type":"testStart","time":2}',
	'{"test":{"id":5,"name":"skipped placeholder","suiteID":0,"groupIDs":[2],"metadata":{"skip":true,"skipReason":"not ready"},"line":13,"column":3,"url":"file:///t/test/math_test.dart"},"type":"testStart","time":3}',
	'{"testID":1,"result":"success","skipped":false,"hidden":true,"type":"testDone","time":100}',
	'{"testID":3,"result":"success","skipped":false,"hidden":false,"type":"testDone","time":101}',
	'{"testID":4,"error":"Expected: <3>\\n  Actual: <2>\\n","stackTrace":"package:matcher           expect\\ntest/math_test.dart 10:5  main.<fn>\\n","isFailure":true,"type":"error","time":102}',
	'{"testID":4,"result":"failure","skipped":false,"hidden":false,"type":"testDone","time":103}',
	'{"testID":5,"result":"success","skipped":true,"hidden":false,"type":"testDone","time":104}',
	'{"success":false,"type":"done","time":105}',
].join("\n");

// Real compile-error stream: the failing suite surfaces a non-hidden
// testDone with result "error" plus an error event with isFailure: false.
const REAL_COMPILE_ERROR_STREAM = [
	'{"test":{"id":3,"name":"loading test/broken_test.dart","suiteID":2,"groupIDs":[],"metadata":{"skip":false,"skipReason":null},"line":null,"column":null,"url":null},"type":"testStart","time":5}',
	'{"testID":3,"error":"Failed to load \\"test/broken_test.dart\\":\\ntest/broken_test.dart:3:37: Error: Undefined name \'x\'.","stackTrace":"package:test_core/src/runner/vm/platform.dart 428:7   VMPlatform._compileToKernel\\n","isFailure":false,"type":"error","time":530}',
	'{"testID":3,"result":"error","skipped":false,"hidden":false,"type":"testDone","time":532}',
	'{"testID":1,"result":"success","skipped":false,"hidden":true,"type":"testDone","time":587}',
	'{"success":false,"type":"done","time":600}',
].join("\n");

describe("summarizeTestEvents", () => {
	test("counts pass/fail/skip from the real stream, ignoring hidden loader tests", () => {
		const { summary, passed, failed, skipped } = summarizeTestEvents(REAL_TEST_STREAM);
		expect(passed).toBe(1);
		expect(failed).toBe(1);
		expect(skipped).toBe(1);
		expect(summary).toContain("1 passed, 1 failed, 1 skipped.");
		expect(summary).toContain("intentionally failing");
		expect(summary).toContain("Expected: <3>");
	});

	test("counts compile errors as failures and surfaces the loader error", () => {
		const { summary, passed, failed } = summarizeTestEvents(REAL_COMPILE_ERROR_STREAM);
		expect(passed).toBe(0);
		expect(failed).toBe(1);
		expect(summary).toContain("0 passed, 1 failed, 0 skipped.");
		expect(summary).toContain("Failed to load");
		expect(summary).toContain("Undefined name 'x'");
	});

	test("tolerates non-JSON lines", () => {
		const { failed } = summarizeTestEvents(`garbage line\n${REAL_TEST_STREAM}`);
		expect(failed).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Pure helpers — dart_fix text summarizer (SDK 3.13 output shape)
// ---------------------------------------------------------------------------

const REAL_FIX_DRY_RUN = [
	"Computing fixes in dartprobe (dry run)...",
	"",
	"3 proposed fixes in 2 files.",
	"",
	"lib/fixA.dart",
	"  duplicate_import - 1 fix",
	"  unused_import - 1 fix",
	"",
	"lib/fixB.dart",
	"  unnecessary_this - 1 fix",
	"",
	"To fix an individual diagnostic, run one of:",
	"  dart fix --apply --code=duplicate_import ",
	"  dart fix --apply --code=unnecessary_this ",
	"  dart fix --apply --code=unused_import ",
	"",
	"To fix all diagnostics, run:",
	"  dart fix --apply ",
].join("\n");

const REAL_FIX_APPLY = [
	"Computing fixes in dartprobe...",
	"Applying fixes...",
	"",
	"lib/fixA.dart",
	"  duplicate_import - 1 fix",
	"",
	"1 fix made in 1 file.",
].join("\n");

describe("summarizeFixOutput", () => {
	test("extracts count, file, and code lines from a real dry run", () => {
		const s = summarizeFixOutput(REAL_FIX_DRY_RUN);
		expect(s).toContain("3 proposed fixes in 2 files.");
		expect(s).toContain("lib/fixA.dart");
		expect(s).toContain("duplicate_import - 1 fix");
		expect(s).toContain("unnecessary_this - 1 fix");
		expect(s).not.toContain("Computing fixes in dartprobe");
		expect(s).not.toContain("To fix an individual diagnostic");
	});

	test("extracts the applied summary", () => {
		const s = summarizeFixOutput(REAL_FIX_APPLY);
		expect(s).toContain("1 fix made in 1 file.");
		expect(s).toContain("duplicate_import - 1 fix");
	});

	test("passes through Nothing to fix", () => {
		const s = summarizeFixOutput("Computing fixes in dartprobe (dry run)...\nNothing to fix!");
		expect(s).toContain("Nothing to fix!");
	});

	test("falls back to a capped excerpt on unrecognized formats", () => {
		const text = Array.from({ length: 100 }, (_, i) => `unrecognized line ${i}`).join("\n");
		const s = summarizeFixOutput(text);
		expect(s).toContain("unrecognized line 0");
		expect(s).toContain("output format not recognized");
		expect(s).not.toContain("unrecognized line 99");
	});
});

// ---------------------------------------------------------------------------
// Pure helpers — build_runner log filter (build_runner 2.10 / SDK 3.13 shape)
// ---------------------------------------------------------------------------

const REAL_BUILD_RUNNER_SUCCESS = [
	"  0s dart_probe:copy_builder on 1 input; lib/model.dart",
	"  0s dart_probe:copy_builder on 1 input: 1 skipped",
	"  Built with build_runner/aot in 0s; wrote 0 outputs.",
].join("\n");

const REAL_BUILD_RUNNER_FAILURE = [
	"  0s dart_probe:copy_builder on 1 input; lib/model.dart",
	"E dart_probe:copy_builder on lib/model.dart:",
	"  Bad state: boom severe failure",
	"  #0      _CopyBuilder.build (file:///tmp/dartprobe/tool/generator.dart:11)",
	"  #1      Build._buildForPrimaryInput.<anonymous closure>.<anonymous closure> (package:build_runner/src/build/build.dart:467)",
	"  0s dart_probe:copy_builder on 1 input: 2 no-op",
	"  Failed to build with build_runner/aot in 10s; wrote 0 outputs.",
].join("\n");

describe("filterBuildRunnerLines", () => {
	test("keeps level lines and the summary, drops progress chatter", () => {
		const kept = filterBuildRunnerLines(REAL_BUILD_RUNNER_FAILURE);
		expect(kept.some((l) => l.startsWith("E dart_probe:copy_builder on"))).toBe(true);
		expect(kept.some((l) => l.includes("Failed to build with"))).toBe(true);
		expect(kept.some((l) => l.includes("#0"))).toBe(false);
		expect(kept.some((l) => l.includes("copy_builder on 1 input;"))).toBe(false);
	});

	test("keeps the older [SEVERE]/[WARNING] format defensively", () => {
		const kept = filterBuildRunnerLines("[SEVERE] something broke\n[WARNING] careful\nINFO fine");
		expect(kept).toHaveLength(2);
	});
});

describe("summarizeBuildRunnerOutput", () => {
	test("success log: summary line survives", () => {
		const s = summarizeBuildRunnerOutput(REAL_BUILD_RUNNER_SUCCESS, "");
		expect(s).toContain("Built with build_runner/aot");
	});

	test("failure log: error line and failed summary survive", () => {
		const s = summarizeBuildRunnerOutput(REAL_BUILD_RUNNER_FAILURE, "");
		// the "E <builder> on <file>:" level line is kept; its indented detail
		// lines (message, stack frames) are deliberately dropped as noise
		expect(s).toContain("E dart_probe:copy_builder on lib/model.dart:");
		expect(s).toContain("Failed to build with");
		expect(s).not.toContain("#0");
	});

	test("falls back to the stream tails when nothing matches", () => {
		const s = summarizeBuildRunnerOutput("a\nb\nc", "Found no `pubspec.yaml` file in X\n");
		expect(s).toContain("Found no `pubspec.yaml`");
		expect(s).toContain("c");
	});
});

// ---------------------------------------------------------------------------
// bash → tool redirection
// ---------------------------------------------------------------------------

describe("findBashRedirect", () => {
	test("maps the dart subcommands the tools wrap", () => {
		expect(findBashRedirect("dart analyze --format=machine")?.tool).toBe("dart_analyze");
		expect(findBashRedirect("dart test -r json")?.tool).toBe("dart_test");
		expect(findBashRedirect("dart fix --dry-run")?.tool).toBe("dart_fix");
		expect(findBashRedirect("dart run build_runner build --delete-conflicting-outputs")?.tool).toBe("build_runner");
	});

	test("matches chained commands at command positions", () => {
		expect(findBashRedirect("cd /tmp && dart test")?.tool).toBe("dart_test");
		expect(findBashRedirect("dart fix --apply && dart analyze")?.tool).toBe("dart_fix");
		expect(findBashRedirect("$(dart analyze) | head")?.tool).toBe("dart_analyze");
	});

	test("does not match mentions inside quoted arguments", () => {
		expect(findBashRedirect('echo "dart test"')).toBeUndefined();
		expect(findBashRedirect("grep 'dart analyze' notes.md")).toBeUndefined();
		expect(findBashRedirect("perl -e 's/.../dart fix/' README.md")).toBeUndefined();
	});

	test("does not match mentions at non-command positions", () => {
		expect(findBashRedirect("echo use the dart analyze tool")).toBeUndefined();
	});

	test("does not match non-dart or glued commands", () => {
		expect(findBashRedirect("ls -la")).toBeUndefined();
		expect(findBashRedirect("dartanalyzer lib")).toBeUndefined();
		expect(findBashRedirect("dart run build_runner watch")).toBeUndefined();
		expect(findBashRedirect("dart run build_runner build --thing")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

describe("registration", () => {
	test("registers every dart tool and the doctor command", () => {
		for (const name of ["dart_analyze", "dart_test", "dart_fix", "build_runner"]) {
			expect(tools.has(name)).toBe(true);
			expect(tools.get(name).name).toBe(name);
		}
		expect(commands.has("dart-doctor")).toBe(true);
	});

	test("tool_call listener blocks bash duplicates and names the tool to use", () => {
		const handler = listeners.get("tool_call");
		expect(handler).toBeDefined();

		const blocked = handler?.({ toolName: "bash", input: { command: "dart test -r json" } });
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("dart_test"),
		});

		// unrelated bash and non-bash tool calls pass through untouched
		expect(handler?.({ toolName: "bash", input: { command: "ls -la" } })).toBeUndefined();
		expect(handler?.({ toolName: "read", input: { path: "x.dart" } })).toBeUndefined();
	});

	test("tool_result listener flags FAILURE_FLAG results as errors", () => {
		const handler = listeners.get("tool_result");
		expect(handler).toBeDefined();

		const flagged = handler?.({
			type: "tool_result",
			toolName: "dart_analyze",
			details: { ok: true, hasErrors: true, [FAILURE_FLAG]: true },
		});
		expect(flagged?.isError).toBe(true);
		expect(flagged?.details?.[FAILURE_FLAG]).toBeUndefined();

		expect(
			handler?.({ type: "tool_result", toolName: "dart_analyze", details: { ok: true } }),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// dart_analyze (integration, real dart against the fixture packages)
// ---------------------------------------------------------------------------

describe("dart_analyze tool", () => {
	test(
		"warning-only run: content is right, FAILURE_FLAG not set",
		async () => {
			const res = await execute("dart_analyze", {}, { cwd: FIXTURE_DIR });
			expect(res.details.ok).toBe(true);
			expect(res.details.errorCount).toBe(0);
			expect(res.details.warningCount).toBe(1);
			expect(res.details.hasErrors).toBe(false);
			expect(res.details[FAILURE_FLAG]).toBeUndefined();
			expect(res.content[0].text).toContain("1 issue(s): 0 error(s), 1 warning(s)");
			expect(res.content[0].text).toContain("UNUSED_LOCAL_VARIABLE");
			expect(res.content[0].text).toContain("unusedLocaleMarker");
		},
		120_000,
	);

	test(
		"broken package: compile error is flagged for the tool_result hook",
		async () => {
			const res = await execute("dart_analyze", {}, { cwd: BROKEN_DIR });
			expect(res.details.ok).toBe(true);
			expect(res.details.errorCount).toBe(1);
			expect(res.details.hasErrors).toBe(true);
			expect(res.details[FAILURE_FLAG]).toBe(true);
			expect(res.content[0].text).toContain("1 issue(s): 1 error(s), 0 warning(s)");
			expect(res.content[0].text).toContain("RETURN_OF_INVALID_TYPE");
			expect(res.content[0].text).toContain("fixtures/dart-broken/lib/broken.dart");
		},
		120_000,
	);

	test(
		"diagnosticLimit caps the listing",
		async () => {
			// Count the per-file diagnostic lines in an uncapped run first, then
			// cap below that. Asserting against a computed count (rather than a
			// hardcoded "+1 more") keeps this independent of how many warnings
			// the fixture's resolved lints happen to emit on a given SDK.
			const full = await execute("dart_analyze", {}, { cwd: FIXTURE_DIR });
			const total = full.details.issueCount as number;
			expect(total).toBeGreaterThan(0);

			const capped = await execute("dart_analyze", { diagnosticLimit: 0 }, { cwd: FIXTURE_DIR });
			expect(capped.content[0].text).toContain(`+${total} more`);
			// with limit 0 no diagnostic lines appear — only the summary header
			expect(capped.content[0].text).not.toMatch(/^\s+\d+:\d+ \[/m);
		},
		120_000,
	);
});

// ---------------------------------------------------------------------------
// dart_test (integration)
// ---------------------------------------------------------------------------

describe("dart_test tool", () => {
	test(
		"mixed fixture: pass/fail/skip counts, failure flagged, details surfaced",
		async () => {
			const res = await execute("dart_test", {}, { cwd: FIXTURE_DIR });
			expect(res.details.ok).toBe(false);
			expect(res.details.passed).toBe(1);
			expect(res.details.failed).toBe(1);
			expect(res.details.skipped).toBe(1);
			expect(res.details.exitCode).toBe(1);
			expect(res.details[FAILURE_FLAG]).toBe(true);
			expect(res.content[0].text).toContain("1 passed, 1 failed, 1 skipped.");
			expect(res.content[0].text).toContain("intentionally failing");
			expect(res.content[0].text).toContain("Expected: <3>");
		},
		180_000,
	);

	test(
		"--plain-name filter scopes to the passing test",
		async () => {
			const res = await execute("dart_test", { name: "add works" }, { cwd: FIXTURE_DIR });
			expect(res.details.ok).toBe(true);
			expect(res.details.passed).toBe(1);
			expect(res.details.failed).toBe(0);
			expect(res.details[FAILURE_FLAG]).toBeUndefined();
			expect(res.content[0].text).toContain("1 passed, 0 failed, 0 skipped.");
		},
		180_000,
	);

	test(
		"name filter matching nothing reports the no-tests outcome",
		async () => {
			const res = await execute("dart_test", { name: "no such test exists" }, { cwd: FIXTURE_DIR });
			expect(res.content[0].text).toContain("No tests ran");
		},
		180_000,
	);
});

// ---------------------------------------------------------------------------
// dart_fix (integration; dry run must not touch the committed fixture)
// ---------------------------------------------------------------------------

describe("dart_fix tool", () => {
	test(
		"dry run on the clean fixture reports Nothing to fix, not an error",
		async () => {
			const res = await execute("dart_fix", {}, { cwd: FIXTURE_DIR });
			expect(res.details.ok).toBe(true);
			expect(res.details.apply).toBe(false);
			expect(res.details[FAILURE_FLAG]).toBeUndefined();
			expect(res.content[0].text.startsWith("[DRY RUN")).toBe(true);
			expect(res.content[0].text).toContain("Nothing to fix!");
		},
		120_000,
	);

	test(
		"apply rewrites files in a throwaway copy of the fixture, dry run does not",
		async () => {
			// make a scratch copy with a fixable lint (duplicate import)
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dart-fix-"));
			try {
				fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
				fs.writeFileSync(
					path.join(tmp, "lib", "dup.dart"),
					"import 'dart:math';\nimport 'dart:math';\n\nint f() => max(1, 2);\n",
				);

				const dry = await execute("dart_fix", {}, { cwd: tmp });
				expect(dry.content[0].text).toContain("proposed fix");
				expect(dry.content[0].text).toContain("duplicate_import - 1 fix");
				expect(fs.readFileSync(path.join(tmp, "lib", "dup.dart"), "utf8")).toContain(
					"import 'dart:math';\nimport 'dart:math';",
				);

				const applied = await execute("dart_fix", { apply: true }, { cwd: tmp });
				expect(applied.content[0].text.startsWith("[APPLIED]")).toBe(true);
				expect(applied.content[0].text).toContain("1 fix made in 1 file.");
				expect(fs.readFileSync(path.join(tmp, "lib", "dup.dart"), "utf8")).not.toContain(
					"import 'dart:math';\nimport 'dart:math';",
				);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		180_000,
	);
});

// ---------------------------------------------------------------------------
// build_runner (integration; the fixture has no builders, so the tool must
// still report a clean no-op run correctly)
// ---------------------------------------------------------------------------

describe("build_runner tool", () => {
	test(
		"package without builders: succeeds with a Built summary line",
		async () => {
			const res = await execute("build_runner", {}, { cwd: FIXTURE_DIR });
			expect(res.details.ok).toBe(true);
			expect(res.details.exitCode).toBe(0);
			expect(res.details[FAILURE_FLAG]).toBeUndefined();
			expect(res.content[0].text).toContain("Built with build_runner");
		},
		300_000,
	);

	test(
		"outside a package: spawn-level failure is flagged, not a crash",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dart-nopkg-"));
			try {
				const res = await execute("build_runner", {}, { cwd: tmp });
				expect(res.details.ok).toBe(false);
				expect(res.details[FAILURE_FLAG]).toBe(true);
				expect(res.content[0].text).toContain("Found no `pubspec.yaml`");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		120_000,
	);
});

// ---------------------------------------------------------------------------
// dartexec / doctor plumbing
// ---------------------------------------------------------------------------

describe("dartexec.runDart + doctor", () => {
	test("pre-aborted signal short-circuits to aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const res = await runDart(["analyze", "."], { signal: controller.signal, cwd: FIXTURE_DIR });
		expect(res.aborted).toBe(true);
		expect(res.ok).toBe(false);
		expect(res.spawnFailed).toBe(false);
		expect(res.timedOut).toBe(false);
	});

	test("non-zero exit is a normal result, not a spawn failure", async () => {
		const res = await runDart(["nonexistent-subcommand-xyz"], { cwd: FIXTURE_DIR });
		expect(res.ok).toBe(false);
		expect(res.spawnFailed).toBe(false);
		expect(res.timedOut).toBe(false);
		expect(typeof res.exitCode).toBe("number");
		expect(res.exitCode).not.toBe(0);
	}, 30_000);

	test("timeout kill sets timedOut, not spawnFailed", async () => {
		// `dart test` on the fixture takes >400ms; abort it via a tight timeout
		const res = await runDart(["test", "-r", "json"], { cwd: FIXTURE_DIR, timeout: 100 });
		expect(res.ok).toBe(false);
		expect(res.timedOut).toBe(true);
		expect(res.spawnFailed).toBe(false);
	}, 30_000);

	test("checkDartAvailable reports the reachable toolchain", async () => {
		const res = await checkDartAvailable(FIXTURE_DIR);
		expect(res.available).toBe(true);
		expect(res.version).toMatch(/^Dart SDK version: \d/);
	}, 30_000);

	test("checkDartAvailable reports ENOENT clearly", async () => {
		// run with a PATH that cannot contain dart
		const env = { ...process.env, PATH: "/nonexistent" };
		const origPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const res = await checkDartAvailable(FIXTURE_DIR);
			expect(res.available).toBe(false);
			expect(res.error).toBe("`dart` is not on PATH");
		} finally {
			process.env.PATH = origPath;
			void env;
		}
	}, 30_000);
});

// guard against accidentally dropping the extraction of the registration path
test("default export registers tools into the provided API", () => {
	expect(typeof dartExtension).toBe("function");
});
