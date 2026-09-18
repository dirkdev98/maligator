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

export class PerformanceProcessInterruptedError extends Error {
	readonly signal: NodeJS.Signals;

	constructor(signal: NodeJS.Signals) {
		super(`process interrupted by ${signal}`);
		this.signal = signal;
	}
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
		let interrupted: NodeJS.Signals | undefined;
		let settled = false;
		let forceStop: NodeJS.Timeout | undefined;
		const forceAfterGrace = (signal: NodeJS.Signals) => {
			stopProcessGroup(child, signal);
			forceStop ??= setTimeout(() => stopProcessGroup(child, "SIGKILL"), 2_000);
		};
		const interrupt = (signal: NodeJS.Signals) => {
			interrupted ??= signal;
			forceAfterGrace(signal);
		};
		const onInterrupt = () => interrupt("SIGINT");
		const onTerminate = () => interrupt("SIGTERM");
		process.once("SIGINT", onInterrupt);
		process.once("SIGTERM", onTerminate);
		const cleanup = () => {
			clearTimeout(timeout);
			if (forceStop !== undefined) clearTimeout(forceStop);
			process.removeListener("SIGINT", onInterrupt);
			process.removeListener("SIGTERM", onTerminate);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			forceAfterGrace("SIGTERM");
		}, options.timeoutMs);
		timeout.unref();
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => (stdout += chunk));
		child.stderr?.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			stopProcessGroup(child, "SIGKILL");
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			stopProcessGroup(child, "SIGKILL");
			if (timedOut) {
				reject(new Error(`process timed out after ${options.timeoutMs} ms`));
				return;
			}
			if (interrupted !== undefined) {
				reject(new PerformanceProcessInterruptedError(interrupted));
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
