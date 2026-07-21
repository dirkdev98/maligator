import type { Test262File, Test262Output, Test262Result } from "./types.ts";

export type Test262Policy = "bail" | "complete";
export type Test262Variant = "strict" | "sloppy";

export function test262WorkerCount(
	configuredWorkers: number,
	batchCount: number,
): number {
	return Math.min(configuredWorkers, batchCount);
}

export function parseTest262Policy(value: string | undefined): Test262Policy {
	if (value === undefined || value === "complete") {
		return "complete";
	}
	if (value === "bail") {
		return "bail";
	}
	throw new Error(`--policy only supports 'bail' or 'complete', got '${value}'`);
}

export function test262RunsInVariant(
	file: Pick<Test262File, "frontmatter">,
	variant: Test262Variant,
): boolean {
	const flags = file.frontmatter.flags ?? [];
	if (variant === "strict") {
		return !flags.includes("noStrict");
	}
	return !(
		flags.includes("onlyStrict") ||
		flags.includes("module") ||
		flags.includes("raw")
	);
}

export function test262BatchRegressions(
	results: ReadonlyArray<{ path: string; result: Test262Result }>,
	filesByPath: ReadonlyMap<string, Test262File>,
	previous: Readonly<Test262Output["results"]>,
	variant: Test262Variant,
): Array<string> {
	const regressions: Array<string> = [];
	for (const { path, result } of results) {
		const file = filesByPath.get(path);
		if (
			file &&
			test262RunsInVariant(file, variant) &&
			previous[path] === "PASSED" &&
			result !== "PASSED"
		) {
			regressions.push(path);
		}
	}
	return regressions;
}

export function test262FoldedRegressions(
	current: ReadonlyMap<string, Test262Output["results"][string]>,
	previous: Readonly<Test262Output["results"]>,
): Array<string> {
	return [...current]
		.filter(([path, result]) => previous[path] === "PASSED" && result !== "PASSED")
		.map(([path]) => path);
}
