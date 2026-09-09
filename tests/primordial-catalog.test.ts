import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { primordialInstallerSourceInventory } from "../scripts/primordial-catalog-data.ts";
import {
	summarizeStaticValueCoverage,
	validateStaticValueCoverage,
} from "../scripts/static-value-coverage.ts";
import type { StaticValueCoverage } from "../scripts/static-value-coverage.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	builtinInvocationSummary,
	provePrimordialAccess,
	exactBuiltinCallDescriptors,
	literalPrototypeMethods,
	resolvePrimordialProperty,
} from "../src/compiler/shared/builtin-registry.ts";
import { worldFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";

const catalog = getPrimordialCatalog();
const coverage = JSON.parse(
	readFileSync("tests/fixtures/primordial-inventory/coverage.json", "utf8"),
) as StaticValueCoverage;
const sources = new Map<string, string>();
function sourceContains(file: string, text: string) {
	if (!existsSync(file)) return false;
	let source = sources.get(file);
	if (source === undefined) {
		source = readFileSync(file, "utf8");
		sources.set(file, source);
	}
	return source.includes(text);
}
const coverageEvidence = {
	witnessExists: (witness: { file: string; test: string; case?: string }) =>
		sourceContains(witness.file, witness.test) &&
		(witness.case === undefined ||
			sourceContains(witness.file, JSON.stringify(witness.case))),
	implementationExists: (implementation: { file: string; symbol: string }) =>
		sourceContains(implementation.file, implementation.symbol),
};

describe("shared primordial catalog and coverage obligations", () => {
	it.each([
		["String.prototype.trim", "F-11"],
		["String.prototype.repeat", "F-10"],
		["String.prototype.replace", "F-12"],
		["Math.sin", "F-07"],
		["Math.round", "F-06"],
		["Number.prototype.toFixed", "F-03"],
		["Number.prototype.toLocaleString", "L-04"],
		["BigInt.prototype.toLocaleString", "L-04"],
		["parseInt", "F-14"],
		["parseFloat", "F-14"],
		["globalThis.escape", "F-13"],
	])("assigns invocation modes of %s to the owning descriptor task", (owner, task) => {
		for (const key of ["<call>", "<construct>"])
			expect(
				coverage.rows.find((row) => row.owner === owner && row.key === key)?.task,
			).toBe(task);
	});
	it("does not infer installed globals or services from the full catalog in smaller builds", () => {
		const disabled = worldFactsFromConfig(
			resolveBuildConfig({
				engine: {
					primordials: "locked",
					intl: { enabled: false },
					regexp: false,
					temporal: false,
				},
			}),
		);
		for (const key of ["Intl", "RegExp", "Temporal"])
			expect(
				provePrimordialAccess(
					disabled,
					{ kind: "intrinsic", id: "globalThis", realm: "current" },
					key,
				),
			).toBeUndefined();
		const collator = worldFactsFromConfig(
			resolveBuildConfig({
				engine: {
					primordials: "locked",
					intl: { enabled: true, features: ["collator"] },
				},
			}),
		);
		for (const key of ["Collator", "Locale", "getCanonicalLocales"])
			expect(
				provePrimordialAccess(
					collator,
					{ kind: "intrinsic", id: "Intl", realm: "current" },
					key,
				)?.resolution?.value,
			).toBeDefined();
		expect(
			provePrimordialAccess(
				collator,
				{ kind: "intrinsic", id: "Intl", realm: "current" },
				"NumberFormat",
			),
		).toBeUndefined();
	});

	it("requires an audited source inventory whenever an installer changes", () => {
		expect(primordialInstallerSourceInventory()).toEqual(
			JSON.parse(
				readFileSync("tests/fixtures/primordial-inventory/installers.json", "utf8"),
			),
		);
	});
	it("covers every native-discovered descriptor without claiming pending work is complete", () => {
		expect(() =>
			validateStaticValueCoverage(coverage, catalog, coverageEvidence),
		).not.toThrow();
		expect(() =>
			validateStaticValueCoverage({ ...coverage, rows: coverage.rows.slice(1) }, catalog),
		).toThrow("no coverage record");
		expect(() =>
			validateStaticValueCoverage(coverage, catalog, { closure: true }),
		).toThrow("Pending optimization obligations");
	});
	it("expands grouped decisions without allowing overlapping cells or hiding another task's pending work", () => {
		const negative = {
			file: "tests/primordial-catalog.test.ts",
			test: "expands grouped decisions",
		};
		const decision = {
			profiles: coverage.profiles,
			axes: coverage.axes,
			state: "not-applicable" as const,
			reason: "The synthetic grid fixture has no observable operation",
			lowering: "semantic-boundary" as const,
			negative,
		};
		const task = "F-01";
		const closed = {
			...coverage,
			rows: coverage.rows.map((row) =>
				row.task === task ? { ...row, decisions: [decision] } : row,
			),
		};
		expect(() =>
			validateStaticValueCoverage(closed, catalog, {
				...coverageEvidence,
				closure: true,
				tasks: [task],
			}),
		).not.toThrow();
		expect(() =>
			validateStaticValueCoverage(closed, catalog, {
				...coverageEvidence,
				closure: true,
			}),
		).toThrow("Pending optimization obligations");
		const summary = summarizeStaticValueCoverage(closed, [task]);
		expect(summary).toHaveLength(1);
		expect(summary[0]!.pending).toBe(0);
		expect(summary[0]!.notApplicable).toBe(
			summary[0]!.exposures * coverage.axes.length * coverage.profiles.length,
		);
		const overlap = {
			...closed,
			rows: closed.rows.map((row) =>
				row.task === task
					? {
							...row,
							decisions: [
								...row.decisions,
								{ ...decision, profiles: [coverage.profiles[0]!], axes: ["R"] },
							],
						}
					: row,
			),
		};
		expect(() => validateStaticValueCoverage(overlap, catalog)).toThrow(
			"Invalid coverage cell",
		);
		expect(() =>
			validateStaticValueCoverage(closed, catalog, { closure: true, tasks: [task] }),
		).toThrow("requires witness and implementation validation");
		expect(() =>
			validateStaticValueCoverage(closed, catalog, {
				...coverageEvidence,
				closure: true,
				tasks: [],
			}),
		).toThrow("Unknown coverage closure task");
	});
	it("requires source evidence for implemented grouped cells", () => {
		const first = coverage.rows[0]!;
		const witness = {
			file: "tests/primordial-catalog.test.ts",
			test: "requires source evidence",
		};
		const decision = {
			profiles: [coverage.profiles[0]!],
			axes: ["R", "D"],
			state: "implemented" as const,
			lowering: "direct" as const,
			positive: witness,
			negative: witness,
			implementation: {
				file: "scripts/static-value-coverage.ts",
				symbol: "validateStaticValueCoverage",
			},
		};
		const supplied = {
			...coverage,
			rows: [{ ...first, decisions: [decision] }, ...coverage.rows.slice(1)],
		};
		expect(() =>
			validateStaticValueCoverage(supplied, catalog, coverageEvidence),
		).not.toThrow();
		expect(() =>
			validateStaticValueCoverage(supplied, catalog, {
				...coverageEvidence,
				implementationExists: () => false,
			}),
		).toThrow("Missing implementation path");
		expect(() =>
			validateStaticValueCoverage(supplied, catalog, {
				...coverageEvidence,
				witnessExists: () => false,
			}),
		).toThrow("Missing rejection witness");
	});
	it("rejects blanket runtime-only exemptions and direct dispatch as allocation elimination", () => {
		const first = coverage.rows[0]!;
		const negative = { file: "boundary.test.ts", test: "runtime boundary" };
		const invalid = {
			...coverage,
			rows: [
				{
					...first,
					decisions: [
						{
							profiles: [coverage.profiles[0]!],
							axes: ["A"],
							state: "not-applicable" as const,
							reason: "runtime-only family",
							negative,
							lowering: "semantic-boundary" as const,
						},
					],
				},
				...coverage.rows.slice(1),
			],
		};
		expect(() => validateStaticValueCoverage(invalid, catalog)).toThrow(
			"not semantic inapplicability",
		);
		const direct = {
			...invalid,
			rows: [
				{
					...first,
					decisions: [
						{
							profiles: [coverage.profiles[0]!],
							axes: ["A"],
							state: "implemented" as const,
							positive: negative,
							negative,
							lowering: "direct" as const,
						},
					],
				},
				...coverage.rows.slice(1),
			],
		};
		expect(() => validateStaticValueCoverage(direct, catalog)).toThrow(
			"does not discharge virtualization",
		);
	});

	it("requires exact prototypes, absent own overrides, a current realm and enabled services", () => {
		const world = worldFactsFromConfig(resolveBuildConfig({}));
		const receiver = {
			kind: "fresh-allocation",
			prototype: "Array.prototype",
			realm: "current",
			ownKeys: [],
			ownKeysComplete: true,
			stableUntilRead: true,
		} as const;
		expect(provePrimordialAccess(world, receiver, "includes")?.kind).toBe("descriptor");
		expect(provePrimordialAccess(world, receiver, "includex")?.kind).toBe("absent");
		for (const invalid of [
			{ kind: "brand-only", brand: "array" } as const,
			{ ...receiver, ownKeys: ["includes"] },
			{ ...receiver, ownKeysComplete: false },
			{ ...receiver, stableUntilRead: false },
			{ ...receiver, realm: "unknown" } as const,
			{ ...receiver, prototype: "arbitrary" },
		])
			expect(provePrimordialAccess(world, invalid, "includes")).toBeUndefined();
		expect(
			provePrimordialAccess(
				{ ...world, primordialPolicy: "mutable" },
				receiver,
				"includes",
			),
		).toBeUndefined();
		expect(
			provePrimordialAccess(
				{ ...world, eval: "runtime", realms: true },
				receiver,
				"includes",
			)?.kind,
		).toBe("descriptor");
		const partial = worldFactsFromConfig(
			resolveBuildConfig({ engine: { intl: { enabled: true, features: ["collator"] } } }),
		);
		expect(
			provePrimordialAccess(
				partial,
				{ ...receiver, prototype: "Intl.Collator.prototype" },
				"compare",
			)?.resolution?.getter,
		).toBeDefined();
		expect(
			provePrimordialAccess(
				partial,
				{ ...receiver, prototype: "Intl.NumberFormat.prototype" },
				"format",
			),
		).toBeUndefined();
		expect(
			provePrimordialAccess(
				world,
				{
					kind: "intrinsic",
					id: "%mal_host_install_node_fs:readFileSync%",
					realm: "current",
				},
				"name",
			),
		).toBeUndefined();
	});
	it("retains the literal surface and all exact builtin identities", () => {
		expect(literalPrototypeMethods).toHaveLength(117);
		for (const operation of Object.keys(exactBuiltinCallDescriptors)) {
			const dot = operation.lastIndexOf(".");
			expect(
				resolvePrimordialProperty(operation.slice(0, dot), operation.slice(dot + 1))
					?.value?.[2],
				operation,
			).toSatisfy((flags: number) => (flags & 2) !== 0);
		}
	});
	it("distinguishes symbol keys, callable aliases, inherited members and accessor halves", () => {
		expect(
			resolvePrimordialProperty("Array.prototype", { symbol: "%Symbol.iterator%" })
				?.value,
		).toBe(resolvePrimordialProperty("Array.prototype", "values")?.value);
		expect(resolvePrimordialProperty("Array.prototype", "@@iterator")).toBeUndefined();
		expect(resolvePrimordialProperty("String.prototype", "trimStart")?.value).toBe(
			resolvePrimordialProperty("String.prototype", "trimLeft")?.value,
		);
		expect(
			resolvePrimordialProperty("Number.prototype", "hasOwnProperty")?.owner[0],
		).toBe("Object.prototype");
		const compare = resolvePrimordialProperty("Intl.Collator.prototype", "compare");
		expect(compare?.getter).toBeDefined();
		expect(compare?.value).toBeUndefined();
		expect(compare?.setter).toBeUndefined();
	});
	it("separates coercion, receiver exposure, returned aliases and fresh results", () => {
		const includes = builtinInvocationSummary("Array.prototype", "includes");
		const join = builtinInvocationSummary("Array.prototype", "join");
		expect(includes.mayEnqueueJob).toBe(true);
		expect(
			builtinInvocationSummary("Array.prototype", "keys").steps.some(
				(step) => step.subject === "receiver.length",
			),
		).toBe(false);
		expect(builtinInvocationSummary("String.prototype", "split").result).toBe("unknown");
		expect(includes.steps).toContainEqual({
			kind: "coerce",
			subject: "argument[1]:ToIntegerOrInfinity",
			when: ["nonempty-receiver", "object-argument"],
			exposes: "none",
		});
		expect(
			join.steps.some((step) => step.when === "object-element" && step.kind === "coerce"),
		).toBe(true);
		expect(
			builtinInvocationSummary("Array.prototype", "map").steps.some(
				(step) => step.kind === "call" && step.exposes === "receiver",
			),
		).toBe(true);
		expect(builtinInvocationSummary("Object.prototype", "valueOf").result).toBe(
			"receiver-alias",
		);
		expect(builtinInvocationSummary("Array.prototype", "slice").result).toBe(
			"fresh-array",
		);
		expect(
			builtinInvocationSummary("Array.prototype", "keys").steps.some(
				(step) => step.kind === "retain",
			),
		).toBe(true);
		expect(
			builtinInvocationSummary("Array.prototype", "toSorted").steps.some(
				(step) => step.kind === "call" && step.subject.includes("comparator"),
			),
		).toBe(true);
	});
});
