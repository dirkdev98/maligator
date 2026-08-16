import { execFileSync } from "node:child_process";

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
	try {
		const stdout = execFileSync(binaryPath, args, { env, encoding: "utf-8" });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const result = error as Error & {
			status?: number | null;
			signal?: NodeJS.Signals | null;
			stdout?: string | null;
			stderr?: string | null;
		};
		const hasStatus = result.status !== undefined && result.status !== null;
		const hasSignal = result.signal !== undefined && result.signal !== null;
		if (!hasStatus && !hasSignal) throw error;
		return {
			status: result.status ?? undefined,
			signal: result.signal ?? undefined,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}
}
