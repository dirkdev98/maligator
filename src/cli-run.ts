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
	timedOut?: true;
}

export function executeBinaryCaptured(
	binaryPath: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
	timeoutMs?: number,
): CapturedRunOutcome {
	const result = spawnSync(binaryPath, args, {
		env,
		encoding: "utf8",
		timeout: timeoutMs,
		killSignal: timeoutMs === undefined ? undefined : "SIGKILL",
	});
	const timedOut =
		result.error !== undefined &&
		"code" in result.error &&
		result.error.code === "ETIMEDOUT";
	if (
		result.error !== undefined &&
		!timedOut &&
		result.status === null &&
		result.signal === null
	)
		throw result.error;
	return {
		status: result.status ?? undefined,
		signal: result.signal ?? undefined,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(timedOut ? { timedOut: true } : {}),
	};
}
