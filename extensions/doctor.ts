import { execFile } from "node:child_process";

// --- toolchain reachability check -----------------------------------------
//
// `dart --version` prints its version string to **stdout** (verified against
// SDK 3.x: the pre-3.x behavior of writing to stderr is gone, and the old
// `dart version` spelling is no longer a subcommand at all — it exits 64 with
// "Could not find a command named \"version\""). Read both streams and prefer
// whichever actually has the version line, so a future stream flip can't
// regress the doctor into reporting an unreachable toolchain that works.

interface DartAvailability {
    available: boolean;
    version?: string;
    error?: string;
}

const DOCTOR_TIMEOUT_MS = 5_000;

export function checkDartAvailable(cwd?: string, signal?: AbortSignal): Promise<DartAvailability> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ available: false, error: "aborted" });
            return;
        }
        execFile(
            "dart",
            ["--version"],
            { cwd, timeout: DOCTOR_TIMEOUT_MS, signal },
            (error, stdout, stderr) => {
                if (error) {
                    if (signal?.aborted || (error as NodeJS.ErrnoException).code === "ABORT_ERR") {
                        resolve({ available: false, error: "aborted" });
                        return;
                    }
                    const reason =
                        (error as NodeJS.ErrnoException).code === "ENOENT"
                            ? "`dart` is not on PATH"
                            : (stderr?.toString().trim() || stdout?.toString().trim() || String(error));
                    resolve({ available: false, error: reason });
                    return;
                }
                const version =
                    stdout?.toString().trim() || stderr?.toString().trim() || "(no version output)";
                resolve({ available: true, version });
            },
        );
    });
}
