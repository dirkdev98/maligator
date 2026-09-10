import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function stopTestProcesses(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		if (child.exitCode === null && child.signalCode === null) {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
		}
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Owns test scratch until the child exits; retained artifacts are always explicit. */
export async function runTestProcess(
	executable: string,
	args: ReadonlyArray<string>,
	options: { environment: NodeJS.ProcessEnv; keepArtifacts?: boolean },
): Promise<number> {
	const temporary = mkdtempSync(path.join(os.tmpdir(), "maligator-tests-"));
	let child: ChildProcess | undefined;
	let interrupted: NodeJS.Signals | undefined;
	let forceStop: NodeJS.Timeout | undefined;
	const stop = (signal: NodeJS.Signals) => {
		if (child === undefined) return;
		if (interrupted !== undefined) {
			stopTestProcesses(child, "SIGKILL");
			return;
		}
		interrupted = signal;
		stopTestProcesses(child, signal);
		forceStop = setTimeout(() => {
			if (child !== undefined) stopTestProcesses(child, "SIGKILL");
		}, 5000);
		forceStop.unref();
	};
	const onInterrupt = () => stop("SIGINT");
	const onTerminate = () => stop("SIGTERM");
	try {
		const launched = spawn(executable, [...args], {
			stdio: "inherit",
			detached: process.platform !== "win32",
			env: {
				...options.environment,
				TMPDIR: temporary,
				TMP: temporary,
				TEMP: temporary,
			},
		});
		child = launched;
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		const result = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			launched.once("error", reject);
			launched.once("close", (code, signal) => resolve({ code, signal }));
		});
		const signal = interrupted ?? result.signal;
		return signal === null ? (result.code ?? 1) : 128 + os.constants.signals[signal];
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onTerminate);
		if (forceStop !== undefined) clearTimeout(forceStop);
		// A completed test runner can leave subprocesses in its private process group.
		if (child !== undefined) stopTestProcesses(child, "SIGKILL");
		if (options.keepArtifacts === true) {
			console.log(`[test-artifacts] retained ${temporary}`);
		} else {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}
