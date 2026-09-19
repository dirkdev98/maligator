import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PerformanceProcessInterruptedError } from "../scripts/performance-process.ts";
import { loadRuntimeGapCatalog } from "../scripts/runtime-gap-catalog.ts";
import { RUNTIME_GAP_EXPERIMENTS } from "../scripts/runtime-gap-experiment.ts";
import {
	assertRuntimeGapParity,
	captureOptionalResource,
	parseKernelOutput,
	RuntimeGapParityError,
	summarizeRuntimeGapCategories,
} from "../scripts/runtime-gap.ts";
import type {
	CompilerHostGapKernelResult,
	KernelOutput,
} from "../scripts/runtime-gap.ts";

function fixtureOutput(id: string): {
	readonly id: string;
	readonly operations: number;
	readonly checksum: number;
} {
	const descriptor = loadRuntimeGapCatalog().cases.find(
		(candidate) => candidate.id === id,
	);
	if (descriptor === undefined) throw new Error(`unknown runtime-gap case: ${id}`);
	const parsed: unknown = JSON.parse(
		execFileSync(process.execPath, [descriptor.fixturePath, "1"], { encoding: "utf8" }),
	);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("runtime-gap case produced an invalid report");
	}
	return parsed as {
		readonly id: string;
		readonly operations: number;
		readonly checksum: number;
	};
}

describe("runtime-gap case catalog", () => {
	it("keeps generated operation microcases current", () => {
		execFileSync(
			process.execPath,
			["scripts/generate-runtime-gap-microcases.mts", "--check"],
			{ stdio: "pipe" },
		);
	});

	it("finds the result record when V8 emits a trailing GC trace", () => {
		const record = JSON.stringify({
			schema: 2,
			workload: "runtime-gap-case-v2",
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

	it("plans the explicit bounded quick suite without writing reports", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-runtime-gap-plan-"));
		const output = path.join(directory, "report.json");
		const markdown = path.join(directory, "report.md");
		try {
			const plan = JSON.parse(
				execFileSync(
					process.execPath,
					[
						"scripts/performance.ts",
						"gap",
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
				readonly cases: ReadonlyArray<{ readonly id: string; readonly suite: string }>;
			};
			const catalog = loadRuntimeGapCatalog();
			expect(plan).toMatchObject({ preset: "quick", samples: 3, targetNodeMs: 20 });
			expect(plan.cases.map(({ id }) => id)).toEqual(catalog.presets.quick);
			expect(plan.cases.every(({ suite }) => suite === "runtime")).toBe(true);
			expect(existsSync(output)).toBe(false);
			expect(existsSync(markdown)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("covers explicit runtime suites and compiler algorithm cases", () => {
		const catalog = loadRuntimeGapCatalog();
		const kernels = catalog.cases;
		expect(kernels.filter(({ group }) => group === "primitive")).toHaveLength(19);
		expect(catalog.presets.quick).toHaveLength(37);
		expect(catalog.presets.survey).toHaveLength(66);
		expect(kernels.filter(({ group }) => group === "algorithm")).toHaveLength(15);
		expect(new Set(kernels.map(({ id }) => id)).size).toBe(kernels.length);
		const operationMicrocases = kernels.filter(({ id }) =>
			/^(?:(?:private|public)-(?:field-read|method-call)-|(?:weakmap|map)-get-(?:hit|miss)-|map-get-set-|pair-|(?:typed-array|array)-(?:at-negative|last-index-control)-)/.test(
				id,
			),
		);
		expect(operationMicrocases).toHaveLength(60);
		expect(
			operationMicrocases.every(
				({ id }) =>
					!catalog.presets.quick.includes(id) && !catalog.presets.survey.includes(id),
			),
		).toBe(true);
	});

	it("records a configurable sequence of warmup blocks", () => {
		const descriptor = loadRuntimeGapCatalog().cases.find(
			({ id }) => id === "pair-indexed-control",
		)!;
		const output = JSON.parse(
			execFileSync(process.execPath, [descriptor.fixturePath, "1", "5"], {
				encoding: "utf8",
			}),
		) as { readonly warmupMs: ReadonlyArray<number> };
		expect(output.warmupMs).toHaveLength(5);
	});

	it.each([
		["private-field-read-32-last-known", "public-field-read-32-last-known"],
		["private-field-read-32-last-selected", "public-field-read-32-last-selected"],
		["private-method-call-known", "public-method-call-known"],
		["private-method-call-selected", "public-method-call-selected"],
		["weakmap-get-hit-256-known", "map-get-hit-256-known"],
		["weakmap-get-hit-256-selected", "map-get-hit-256-selected"],
		["weakmap-get-miss-256-known", "map-get-miss-256-known"],
		["weakmap-get-miss-256-selected", "map-get-miss-256-selected"],
		["map-get-set-interleaved", "map-get-set-adjacent"],
		["pair-destructure", "pair-indexed-control"],
		["array-at-negative-known", "array-last-index-control-known"],
		["array-at-negative-selected", "array-last-index-control-selected"],
		["typed-array-at-negative-known", "typed-array-last-index-control-known"],
		["typed-array-at-negative-selected", "typed-array-last-index-control-selected"],
	])("keeps %s matched to %s", (target, control) => {
		const targetOutput = fixtureOutput(target);
		const controlOutput = fixtureOutput(control);
		expect(targetOutput.operations).toBe(controlOutput.operations);
		expect(targetOutput.checksum).toBe(controlOutput.checksum);
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
		const prefixedLength = fixtureOutput("prefixed-rest-length-parameters");
		expect(length).toMatchObject({
			operations: lengthControl.operations,
			checksum: lengthControl.checksum,
		});
		expect(prefixedLength).toMatchObject({
			operations: length.operations,
			checksum: length.checksum,
		});

		const bounded = fixtureOutput("bounded-rest-selection");
		const boundedControl = fixtureOutput("bounded-fixed-selection-control");
		expect(bounded).toMatchObject({
			operations: boundedControl.operations,
			checksum: boundedControl.checksum,
		});
		const fourWayBounded = fixtureOutput("four-way-bounded-rest-selection");
		const fourWayBoundedControl = fixtureOutput(
			"four-way-bounded-fixed-selection-control",
		);
		expect(fourWayBounded).toMatchObject({
			operations: fourWayBoundedControl.operations,
			checksum: fourWayBoundedControl.checksum,
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

		const holeyMembership = fixtureOutput("holey-array-membership");
		const storedZeroMembership = fixtureOutput("stored-zero-array-membership-control");
		expect(holeyMembership.operations).toBe(storedZeroMembership.operations);
		expect(holeyMembership.checksum).toBeGreaterThan(0);
		expect(storedZeroMembership.checksum).toBe(0);
	});

	it("keeps trailing-hole indexOf matched to its stored-zero control", () => {
		const trailingHoles = fixtureOutput("trailing-hole-index-of");
		const storedZero = fixtureOutput("stored-zero-index-of-control");
		expect(trailingHoles).toMatchObject({
			operations: storedZero.operations,
			checksum: storedZero.checksum,
		});
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

	it("retains timing when an optional resource probe is unavailable", async () => {
		expect(
			await captureOptionalResource(() => {
				throw new Error("resource tool unavailable");
			}),
		).toEqual({ resourceFailure: "resource tool unavailable" });
		await expect(
			captureOptionalResource(() => {
				throw new RuntimeGapParityError("work differs");
			}),
		).rejects.toThrow(RuntimeGapParityError);
		await expect(
			captureOptionalResource(() => {
				throw new PerformanceProcessInterruptedError("SIGTERM");
			}),
		).rejects.toThrow(PerformanceProcessInterruptedError);
	});

	it("rejects checksum changes in any measured pass", () => {
		const reference = {
			schema: 2,
			workload: "runtime-gap-case-v2",
			id: "case",
			scale: 1,
			operations: 10,
			checksum: 20,
			elapsedMs: 1,
			measurementStartMs: 1,
			measurementEndMs: 2,
			warmupMs: [1, 1],
		} satisfies KernelOutput;
		expect(() =>
			assertRuntimeGapParity(reference, { ...reference, checksum: 21 }),
		).toThrow(RuntimeGapParityError);
	});

	it("scaffolds an ignored experiment and plans only its declared closure", () => {
		const id = `unit-experiment-${process.pid}`;
		const directory = path.join(RUNTIME_GAP_EXPERIMENTS, id);
		rmSync(directory, { recursive: true, force: true });
		try {
			execFileSync(process.execPath, [
				"scripts/performance.ts",
				"experiment",
				"new",
				id,
				"--from",
				"numeric-scalar-loops",
				"--control",
				"predictable-branches",
			]);
			const plan = JSON.parse(
				execFileSync(
					process.execPath,
					[
						"scripts/performance.ts",
						"experiment",
						"run",
						id,
						"--preset",
						"smoke",
						"--plan=json",
					],
					{ encoding: "utf8" },
				),
			) as { readonly cases: ReadonlyArray<{ readonly id: string }> };
			expect(plan.cases.map(({ id: caseId }) => caseId).sort()).toEqual(
				[id, "predictable-branches"].sort(),
			);
			expect(existsSync(path.join(directory, "report.json"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects scratch dependencies outside the transported two-file closure", () => {
		const id = `unit-experiment-dependency-${process.pid}`;
		const directory = path.join(RUNTIME_GAP_EXPERIMENTS, id);
		rmSync(directory, { recursive: true, force: true });
		try {
			execFileSync(process.execPath, ["scripts/performance.ts", "experiment", "new", id]);
			writeFileSync(path.join(directory, "helper.mjs"), "export const value = 1;\n");
			writeFileSync(
				path.join(directory, "case.mjs"),
				'import { value } from "./helper.mjs"; console.log(value);\n',
			);
			expect(() =>
				execFileSync(process.execPath, [
					"scripts/performance.ts",
					"experiment",
					"run",
					id,
					"--plan=json",
				]),
			).toThrow(/only one source file|self-contained/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses to promote over an existing catalog case", () => {
		const id = "numeric-scalar-loops";
		const directory = path.join(RUNTIME_GAP_EXPERIMENTS, id);
		const catalogCase = loadRuntimeGapCatalog().cases.find(
			(candidate) => candidate.id === id,
		)!;
		const destination = catalogCase.fixturePath;
		const original = readFileSync(destination, "utf8");
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		const { fixturePath: _fixturePath, ...descriptor } = catalogCase;
		writeFileSync(path.join(directory, "case.mjs"), original);
		writeFileSync(
			path.join(directory, "experiment.json"),
			JSON.stringify({ schema: 1, id, case: { ...descriptor, fixture: "case.mjs" } }),
		);
		try {
			expect(() =>
				execFileSync(process.execPath, [
					"scripts/performance.ts",
					"experiment",
					"promote",
					id,
				]),
			).toThrow(/promotion target already exists/);
			expect(readFileSync(destination, "utf8")).toBe(original);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
