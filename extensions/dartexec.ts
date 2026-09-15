import { execFile } from "node:child_process";

const TIMEOUT_MS = 60_000;

// --- generic dart runner -------------------------------------------------
//
// execFile captures stdout/stderr separately (never merged — callers render
// them as distinct sections). The AbortSignal is passed straight to execFile's
// native `signal` option: an aborted call kills the child and the callback
// fires with error.code === "ABORT_ERR".
//
// Distinguishing the three failure shapes matters:
// - spawn failure   (dart not on PATH): no numeric exit code on the error
// - timeout kill    (our own execFile timeout): error.killed, error.signal set
// - non-zero exit   (normal: diagnostics found, tests failed): numeric code

interface DartRunResult {
    ok: boolean;
    spawnFailed: boolean;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    aborted: boolean;
    spawnMessage?: string;
    exitCode?: number | null;
}

export type { DartRunResult };

export function runDart(
    args: string[],
    opts: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<DartRunResult> {
    const { cwd, signal, timeout = TIMEOUT_MS } = opts;
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({
                ok: false,
                spawnFailed: false,
                timedOut: false,
                stdout: "",
                stderr: "",
                aborted: true,
            });
            return;
        }
        execFile(
            "dart",
            args,
            { cwd, timeout, maxBuffer: 10 * 1024 * 1024, signal },
            (error, stdout, stderr) => {
                const out = stdout?.toString() ?? "";
                const err = stderr?.toString() ?? "";
                if (signal?.aborted || (error as NodeJS.ErrnoException | null)?.code === "ABORT_ERR") {
                    resolve({
                        ok: false,
                        spawnFailed: false,
                        timedOut: false,
                        stdout: out,
                        stderr: err,
                        aborted: true,
                    });
                    return;
                }
                if (error?.killed) {
                    // execFile killed the child after its own timeout fired.
                    resolve({
                        ok: false,
                        spawnFailed: false,
                        timedOut: true,
                        stdout: out,
                        stderr: err,
                        aborted: false,
                    });
                    return;
                }
                // Non-zero exit is a normal process result (analyze found issues,
                // tests failed). Only true spawn failures lack a numeric exit code.
                const spawnFailed =
                    !!error && !("code" in error && typeof (error as any).code === "number");
                const exitCode =
                    error && "code" in error && typeof (error as any).code === "number"
                        ? ((error as any).code as number)
                        : error
                            ? null
                            : 0;
                resolve({
                    ok: !error,
                    spawnFailed,
                    timedOut: false,
                    stdout: out,
                    stderr: err,
                    aborted: false,
                    spawnMessage: spawnFailed ? String(error) : undefined,
                    exitCode,
                });
            },
        );
    });
}
