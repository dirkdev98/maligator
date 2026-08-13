import { execFileSync, spawnSync } from "node:child_process";

export interface RunOutcome {
	status?: number;
	signal?: NodeJS.Signals;
}

export function executeBinary(
	binaryPath: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
	stdio: "inherit" | "ignore" = "inherit",
): RunOutcome {
	try {
		execFileSync(binaryPath, args, { env, stdio });
		return { status: 0 };
	} catch (error) {
		const result = error as {
			status?: number | null;
			signal?: NodeJS.Signals | null;
		};
		return {
			status: result.status ?? undefined,
			signal: result.signal ?? undefined,
		};
	}
}

export interface CapturedRunOutcome extends RunOutcome {
	stdout: string;
	stderr: string;
}

export function executeBinaryCaptured(
	binaryPath: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
): CapturedRunOutcome {
	const result = spawnSync(binaryPath, args, { env, encoding: "utf-8" });
	if (result.error) throw result.error;
	return {
		status: result.status ?? undefined,
		signal: result.signal ?? undefined,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}
