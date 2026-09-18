import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

export interface BoundedProcessResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** A timeout owns the complete descendant process group, not only its shell parent. */
export function runBoundedProcess(
	executable: string,
	args: ReadonlyArray<string>,
	options: {
		readonly environment: NodeJS.ProcessEnv;
		readonly timeoutMs: number;
		readonly cwd?: string;
	},
): Promise<BoundedProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.environment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let forceStop: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			stopProcessGroup(child, "SIGTERM");
			forceStop = setTimeout(() => stopProcessGroup(child, "SIGKILL"), 2_000);
			forceStop.unref();
		}, options.timeoutMs);
		timeout.unref();
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => (stdout += chunk));
		child.stderr?.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", (error) => {
			clearTimeout(timeout);
			if (forceStop !== undefined) clearTimeout(forceStop);
			stopProcessGroup(child, "SIGKILL");
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (forceStop !== undefined) clearTimeout(forceStop);
			stopProcessGroup(child, "SIGKILL");
			if (timedOut) {
				reject(new Error(`process timed out after ${options.timeoutMs} ms`));
				return;
			}
			if (signal !== null) {
				reject(new Error(`process terminated by ${signal}: ${stderr}`));
				return;
			}
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}
