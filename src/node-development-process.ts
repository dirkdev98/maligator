import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { runEnv } from "./build-flags.ts";
import type { DevelopmentProcessHost } from "./cli-commands.ts";

export const nodeDevelopmentProcessHost: DevelopmentProcessHost = {
	spawn(executablePath, args) {
		return spawn(executablePath, args, {
			env: runEnv(),
			stdio: "inherit",
			detached: process.platform !== "win32",
		});
	},
	kill(handle, force) {
		const child = handle as ChildProcess;
		const signal = force ? "SIGKILL" : "SIGTERM";
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			return;
		}
		child.kill(signal);
	},
	status(handle) {
		const child = handle as ChildProcess;
		if (child.exitCode !== null) return child.exitCode;
		if (child.signalCode !== null) return 128 + (child.signalCode === "SIGTERM" ? 15 : 1);
		return undefined;
	},
};
