import { SyntaxDiagnostic } from "../compiler/frontend/syntax-diagnostic.ts";
import type { Test262File, Test262Output, Test262Result } from "./types.ts";

export type Test262Policy = "bail" | "complete";
export type Test262Variant = "strict" | "sloppy";

/**
 * Partial selections benefit from retaining their small compiled-object set.
 * A complete strict/sloppy corpus can require tens of GiB per compiler
 * fingerprint, so default it to bounded per-worker scratch unless the caller
 * explicitly opts into the cache.
 */
export function resolveTest262ObjectCache(
	explicit: string | undefined,
	isPartialRun: boolean,
): "0" | "1" {
	if (explicit !== undefined) return explicit === "0" ? "0" : "1";
	return isPartialRun ? "1" : "0";
}

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
		return (
			!flags.includes("noStrict") && !(flags.includes("raw") && !flags.includes("module"))
		);
	}
	return !(flags.includes("onlyStrict") || flags.includes("module"));
}

export function test262SkipReason(
	file: Pick<Test262File, "frontmatter">,
	variant: Test262Variant,
): string | undefined {
	if (file.frontmatter.flags?.includes("CanBlockIsTrue")) {
		return "host: CanBlockIsTrue requires a blocking agent; this host has CanBlock=false";
	}
	if (!test262RunsInVariant(file, variant)) return `variant: no ${variant} execution`;
	return undefined;
}

export function test262ScriptStrictness(
	file: Pick<Test262File, "frontmatter">,
	variant: Test262Variant,
): boolean {
	return !file.frontmatter.flags?.includes("raw") && variant === "strict";
}

export interface Test262Verdict {
	passed: boolean;
	reason: string;
}

export function test262CompileNegativeVerdict(
	file: Pick<Test262File, "frontmatter">,
	error: unknown,
): Test262Verdict | undefined {
	const negative = file.frontmatter.negative;
	if (negative === undefined || negative.phase === "runtime") return undefined;
	const passed =
		error instanceof SyntaxDiagnostic &&
		error.phase === negative.phase &&
		error.name === negative.type;
	return {
		passed,
		reason: passed
			? ""
			: `negative(${negative.phase}): expected ${negative.type}, got ${
					error instanceof SyntaxDiagnostic
						? `${error.phase} ${error.name}`
						: "compiler failure"
				}`,
	};
}

/** The native driver emits the final completion after test-controlled output. */
export function test262RuntimeVerdict(
	file: Pick<Test262File, "frontmatter">,
	output: ReadonlyArray<string>,
	exitCode: number,
): Test262Verdict {
	const completion = output
		.findLast((line) => line.startsWith("##COMPLETION "))
		?.match(/^##COMPLETION (harness|runtime) (NORMAL|THROW)(?: ([0-9a-f]+|-))?$/);
	if (completion === undefined || completion === null) {
		return { passed: false, reason: "missing native completion record" };
	}
	const phase = completion[1];
	const didThrow = completion[2] === "THROW";
	if (phase !== "runtime")
		return { passed: false, reason: "harness failed before test execution" };
	if ((exitCode !== 0) !== didThrow) {
		return {
			passed: false,
			reason: "native exit disagrees with completion record",
		};
	}
	const negative = file.frontmatter.negative;
	if (negative !== undefined) {
		const actual =
			completion[3] === undefined || completion[3] === "-"
				? undefined
				: Buffer.from(completion[3], "hex").toString("utf8");
		const passed = negative.phase === "runtime" && didThrow && actual === negative.type;
		return {
			passed,
			reason: passed
				? ""
				: `negative(${negative.phase}): expected ${negative.type}, got ${didThrow ? `runtime ${actual ?? "unknown constructor"}` : "normal completion"}`,
		};
	}
	if (didThrow) return { passed: false, reason: "uncaught runtime exception" };
	if (file.frontmatter.flags?.includes("async")) {
		const failure = output.find((line) =>
			line.trim().startsWith("Test262:AsyncTestFailure:"),
		);
		if (failure !== undefined) return { passed: false, reason: failure.trim() };
		if (!output.some((line) => line.trim() === "Test262:AsyncTestComplete")) {
			return { passed: false, reason: "async test did not complete" };
		}
	}
	return { passed: true, reason: "" };
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
