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
