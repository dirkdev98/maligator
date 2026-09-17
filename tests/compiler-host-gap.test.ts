import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseKernelOutput,
	summarizeRuntimeGapCategories,
} from "../scripts/bench-compiler-host-gap.ts";
import type { CompilerHostGapKernelResult } from "../scripts/bench-compiler-host-gap.ts";

const fixture = "bench/compiler-host-gap.mjs";

function fixtureOutput(id: string): {
	readonly id: string;
	readonly operations: number;
	readonly checksum: number;
} {
	const parsed: unknown = JSON.parse(
		execFileSync(process.execPath, [fixture, id], { encoding: "utf8" }),
	);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("compiler host-gap fixture produced an invalid report");
	}
	return parsed as {
		readonly id: string;
		readonly operations: number;
		readonly checksum: number;
	};
}

describe("compiler host-gap ladder", () => {
	it("finds the result record when V8 emits a trailing GC trace", () => {
		const record = JSON.stringify({
			schema: 1,
			workload: "runtime-gap-v1",
			id: "allocation-case",
			operations: 10,
			checksum: 42,
			elapsedMs: 3,
			measurementStartMs: 100,
			measurementEndMs: 103,
			warmupMs: [1, 1],
		});
		const trace = '[1:0:0] 104 ms: GC: {"pause":0.2,"gc":"s"}';

		expect(parseKernelOutput(`${record}\n${trace}`).checksum).toBe(42);
	});

	it("plans the bounded runtime sentinel sweep without writing reports", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-runtime-gap-plan-"));
		const output = path.join(directory, "report.json");
		const markdown = path.join(directory, "report.md");
		try {
			const plan = JSON.parse(
				execFileSync(
					process.execPath,
					[
						"scripts/bench-runtime-gap.ts",
						"--output",
						output,
						"--markdown",
						markdown,
						"--plan=json",
					],
					{ encoding: "utf8" },
				),
			) as {
				readonly preset: string;
				readonly samples: number;
				readonly targetNodeMs: number;
				readonly cases: ReadonlyArray<{
					readonly suite: string;
					readonly sentinel: boolean;
				}>;
			};
			expect(plan).toMatchObject({ preset: "quick", samples: 3, targetNodeMs: 20 });
			expect(plan.cases).toHaveLength(37);
			expect(
				plan.cases.every(({ suite, sentinel }) => suite === "runtime" && sentinel),
			).toBe(true);
			expect(existsSync(output)).toBe(false);
			expect(existsSync(markdown)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("covers the runtime sentinel matrix and compiler algorithm kernels", () => {
		const kernels = JSON.parse(
			execFileSync(process.execPath, [fixture, "--list"], { encoding: "utf8" }),
		) as ReadonlyArray<{
			readonly id: string;
			readonly group: string;
			readonly suite: string;
			readonly sentinel: boolean;
		}>;
		expect(kernels.filter(({ group }) => group === "primitive")).toHaveLength(19);
		expect(
			kernels.filter(({ suite, sentinel }) => suite === "runtime" && sentinel),
		).toHaveLength(37);
		expect(kernels.filter(({ group }) => group === "algorithm")).toHaveLength(15);
		expect(new Set(kernels.map(({ id }) => id)).size).toBe(kernels.length);
	});

	it.each([
		"map-operations",
		"memory-versions",
		"array-map",
		"holey-array-traversal",
		"json-stringify-shape-mutation",
		"generator-iterator-semantics",
		"url-parsing",
	])("keeps %s work and checksums deterministic", (id) => {
		const first = fixtureOutput(id);
		const second = fixtureOutput(id);
		expect(second.id).toBe(first.id);
		expect(second.operations).toBe(first.operations);
		expect(second.checksum).toBe(first.checksum);
		expect(first.operations).toBeGreaterThan(0);
	});

	it("keeps rest probes matched to their controls", () => {
		const fixed = fixtureOutput("fixed-arity-parameters");
		const scalarized = fixtureOutput("rest-parameters");
		const dynamic = fixtureOutput("dynamic-rest-parameters");
		expect(scalarized).toMatchObject({
			operations: fixed.operations,
			checksum: fixed.checksum,
		});
		expect(dynamic).toMatchObject({
			operations: fixed.operations,
			checksum: fixed.checksum,
		});

		const length = fixtureOutput("rest-length-parameters");
		const lengthControl = fixtureOutput("fixed-arity-length-control");
		const prefixedLengthControl = fixtureOutput("prefixed-rest-length-control");
		expect(length).toMatchObject({
			operations: lengthControl.operations,
			checksum: lengthControl.checksum,
		});
		expect(prefixedLengthControl).toMatchObject({
			operations: length.operations,
			checksum: length.checksum,
		});

		const bounded = fixtureOutput("bounded-rest-selection");
		const boundedControl = fixtureOutput("bounded-fixed-selection-control");
		expect(bounded).toMatchObject({
			operations: boundedControl.operations,
			checksum: boundedControl.checksum,
		});

		const materialized = fixtureOutput("materialized-rest-parameters");
		const arrayControl = fixtureOutput("materialized-array-control");
		expect(materialized).toMatchObject({
			operations: arrayControl.operations,
			checksum: arrayControl.checksum,
		});

		const batched = fixtureOutput("batched-rest-reduction");
		const batchedCached = fixtureOutput("batched-rest-reduction-cached-length");
		const batchedControl = fixtureOutput("batched-array-reduction-control");
		expect(batched).toMatchObject({
			operations: batchedControl.operations,
			checksum: batchedControl.checksum,
		});
		expect(batchedCached).toMatchObject({
			operations: batched.operations,
			checksum: batched.checksum,
		});
	});

	it("keeps holey traversal probes matched to stored-zero controls", () => {
		const holey = fixtureOutput("matched-holey-array-traversal");
		const storedZero = fixtureOutput("matched-stored-zero-array-traversal");
		expect(holey).toMatchObject({
			operations: storedZero.operations,
			checksum: storedZero.checksum,
		});

		const holeyUndefined = fixtureOutput("holey-array-undefined-check");
		const storedZeroUndefined = fixtureOutput(
			"stored-zero-array-undefined-check-control",
		);
		expect(holeyUndefined.operations).toBe(storedZeroUndefined.operations);
		expect(holeyUndefined.checksum).toBeGreaterThan(0);
		expect(storedZeroUndefined.checksum).toBe(0);
	});

	it("summarizes category ratios without implying workload attribution", () => {
		const makeResult = (
			category: CompilerHostGapKernelResult["category"],
			ratio: number,
		): CompilerHostGapKernelResult =>
			({ category, ratio }) as CompilerHostGapKernelResult;
		const summaries = summarizeRuntimeGapCategories([
			makeResult("allocation-gc", 30),
			makeResult("allocation-gc", 10),
			makeResult("compiler-algorithms", 20),
		]);
		expect(summaries["allocation-gc"]).toEqual({
			cases: 2,
			medianRatio: 20,
			minimumRatio: 10,
			maximumRatio: 30,
		});
		expect(summaries["compiler-algorithms"]).toEqual({
			cases: 1,
			medianRatio: 20,
			minimumRatio: 20,
			maximumRatio: 20,
		});
	});
});
