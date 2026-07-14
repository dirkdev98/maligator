import type { Test262Output } from "./types.ts";

type FoldedResult = Test262Output["results"][string];

export interface Test262PreflightSummary {
	ranTests: number;
	regressionRate: number;
	regressions: Array<string>;
	abortCompiled: boolean;
}

export function summarizeTest262Preflight(
	current: ReadonlyMap<string, FoldedResult>,
	previous: Readonly<Record<string, FoldedResult>>,
	regressionLimit: number,
): Test262PreflightSummary {
	const regressions: Array<string> = [];
	let ranTests = 0;

	for (const [path, result] of current) {
		if (result !== "SKIPPED") {
			ranTests++;
		}
		if (previous[path] === "PASSED" && result === "FAILED") {
			regressions.push(path);
		}
	}

	const regressionRate = ranTests > 0 ? regressions.length / ranTests : 0;
	return {
		ranTests,
		regressionRate,
		regressions,
		abortCompiled: regressionRate > regressionLimit,
	};
}
