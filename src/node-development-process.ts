import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { runEnv } from "./build-flags.ts";
import type { DevelopmentProcessHost } from "./cli-commands.ts";

export const nodeDevelopmentProcessHost: DevelopmentProcessHost = {
	spawn(executablePath, args) {
		return spawn(executablePath, args, {
			env: runEnv(),
			stdio: "inherit",
		});
	},
	kill(handle) {
		(handle as ChildProcess).kill("SIGTERM");
	},
	status(handle) {
		const child = handle as ChildProcess;
		if (child.exitCode !== null) return child.exitCode;
		if (child.signalCode !== null) return 128 + (child.signalCode === "SIGTERM" ? 15 : 1);
		return undefined;
	},
};
