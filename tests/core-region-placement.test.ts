import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import type {
	CoreOptimizationPlan,
	CorePlanSpecialization,
} from "../src/compiler/core/core-ir-regions.ts";
import {
	buildCoreSpecializationRecipeTable,
	projectCoreSpecializationRecipes,
} from "../src/compiler/core/core-specialization-recipes.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import type { ProgramImage, VmRegion } from "../src/compiler/target/program-image.ts";

const OPPOSITE_PLACEMENTS = `globalThis.inline = function inline(value) {
	const match = /(\\d+)x/.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
};
globalThis.open = function open(supplied, value) {
	const match = supplied.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
};`;

const SPLIT_AND_SLICE = `globalThis.parse = function parse(value) {
	const fields = value.split(";");
	return Number(fields[1].slice(2)) + fields[0].length + fields.length;
};`;

const FORWARDED_SPLIT_AND_SLICE = {
	plain: `globalThis.parse = function parse(value, flag) {
		const fields = value.split(";");
		return Number(fields[1].slice(2)) + fields[0].length + fields.length;
	};`,
	forwarded: `globalThis.parse = function parse(value, flag) {
		if (flag) {} else {}
		const fields = value.split(";");
		return Number(fields[1].slice(2)) + fields[0].length + fields.length;
	};`,
};

function semantic(source: string, path: string) {
	return analyzeSourceAndRunSemanticAnalysis(
		source,
		path,
		parseScript(source, { strict: false }),
	);
}

function optimize(
	source: string,
	path: string,
	primordials: "locked" | "mutable" = "locked",
): CoreCompilation {
	return optimizeSemanticProgramToCore(
		semantic(source, path),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
		(_phase, run) => run(),
	);
}

function lower(compilation: CoreCompilation, reuseRegisters = true): ProgramImage {
	return lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution(compilation, { reuseRegisters }),
	);
}

function vmRegions(definition: ProgramImage): ReadonlyArray<VmRegion> {
	return definition.native.functions.flatMap(({ specializations }) => specializations);
}

function propertyPlacement(
	selection: CorePlanSpecialization,
): "in-place" | "call-fallback" | undefined {
	switch (selection.kind) {
		case "string-split-cursor":
			return selection.stringSplitCursor.propertyPlacement;
		case "string-split-projection":
			return selection.stringSplitProjection.propertyPlacement;
		case "string-slice-number":
			return selection.stringSliceNumber.propertyPlacement;
		case "regexp-exec-projection":
			return selection.regexpExecProjection.propertyPlacement;
		default:
			return undefined;
	}
}

function semanticPlanShape(compilation: CoreCompilation) {
	return projectCoreSpecializationRecipes(compilation.plan.recipes)
		.map((selection) => {
			const fn = compilation.program.function(selection.function);
			return {
				kind: selection.kind,
				placement: propertyPlacement(selection),
				admission: selection.admission.mode,
				claimed: selection.claimedInstructions
					.map((instruction) =>
						fn.instructionKind(instruction) === "operation"
							? fn.instructionOpcodeName(instruction)
							: fn.instructionKind(instruction),
					)
					.sort(),
			};
		})
		.sort((left, right) => left.kind.localeCompare(right.kind));
}

function semanticVmShape(definition: ProgramImage) {
	return definition.native.functions
		.flatMap((native) =>
			native.specializations.map((region) => {
				return {
					kind: region.kind,
					representation: region.representation,
					placement: (region as { propertyPlacement?: string }).propertyPlacement,
					admission: region.license.admission.mode,
					anchors: [...region.anchors],
				};
			}),
		)
		.sort((left, right) => left.kind.localeCompare(right.kind));
}

function withVmRegion(
	definition: ProgramImage,
	functionIndex: number,
	regionIndex: number,
	region: VmRegion,
): ProgramImage {
	const owner = definition.native.functions[functionIndex]!;
	const specializations = owner.specializations.with(regionIndex, region);
	return {
		...definition,
		native: {
			...definition.native,
			functions: definition.native.functions.with(functionIndex, {
				...owner,
				specializations,
				regionActions: vmRegionActions(specializations),
			}),
		},
	};
}

describe("Core plan property placement", () => {
	it("records generated-code cost on every selected specialization", () => {
		const plan = optimize(SPLIT_AND_SLICE, "region-cost.mjs").plan;
		const specializations = projectCoreSpecializationRecipes(plan.recipes);
		expect(specializations.length).toBeGreaterThan(0);
		for (const selection of specializations) {
			expect(Number.isFinite(selection.cost.generatedCode)).toBe(true);
			expect(Number.isFinite(selection.cost.compilerWork)).toBe(true);
			expect(Number.isFinite(selection.cost.runtimeBenefit)).toBe(true);
			expect(selection.cost.generatedCode).toBeGreaterThanOrEqual(0);
			expect(selection.cost.compilerWork).toBeGreaterThan(0);
		}
	});

	it("erases a proven exec property load and retains the guarded load", () => {
		const compilation = optimize(OPPOSITE_PLACEMENTS, "placement-opposites.js");
		const projections = projectCoreSpecializationRecipes(compilation.plan.recipes).filter(
			(selection) => selection.kind === "regexp-exec-projection",
		);
		expect(projections).toHaveLength(2);
		expect(
			projections.map((selection) => ({
				placement: selection.regexpExecProjection.propertyPlacement,
				locked: selection.regexpExecProjection.lockedLiteral !== undefined,
			})),
		).toEqual(
			expect.arrayContaining([
				{ placement: "in-place", locked: true },
				{ placement: "in-place", locked: false },
			]),
		);
		const lowered = lower(compilation);
		for (const projection of vmRegions(lowered).filter(
			(region): region is Extract<VmRegion, { kind: "regexp-exec-projection" }> =>
				region.kind === "regexp-exec-projection",
		)) {
			if (projection.lockedFreshLiteral) expect(projection.propertyIp).toBe(-1);
			else expect(projection.propertyIp + 1).toBe(projection.callIp);
		}
	});

	it("keeps placement and eligibility stable when source positions move", () => {
		const shifted = `// leading comment\n\n\n${OPPOSITE_PLACEMENTS.split("\n").join("\n\n")}\n`;
		const baseline = optimize(OPPOSITE_PLACEMENTS, "placement-positions.js");
		const perturbed = optimize(shifted, "placement-positions-shifted.js");
		expect(perturbed.program.sourcePositions).not.toEqual(
			baseline.program.sourcePositions,
		);
		expect(semanticPlanShape(perturbed)).toEqual(semanticPlanShape(baseline));
		expect(semanticVmShape(lower(perturbed))).toEqual(semanticVmShape(lower(baseline)));
	});

	it("selects the same regions and placements with and without register reuse", () => {
		for (const source of [OPPOSITE_PLACEMENTS, SPLIT_AND_SLICE]) {
			const compilation = optimize(source, "placement-register-reuse.js");
			const reused = lower(compilation, true);
			const distinct = lower(compilation, false);
			expect(
				distinct.runtime.functions.map(({ registerCount }) => registerCount),
			).not.toEqual(reused.runtime.functions.map(({ registerCount }) => registerCount));
			expect(semanticVmShape(distinct)).toEqual(semanticVmShape(reused));
		}
	});

	it("keeps placement and eligibility across a semantically empty forwarding block", () => {
		const baseline = optimize(FORWARDED_SPLIT_AND_SLICE.plain, "placement-layout.js");
		const forwarded = optimize(
			FORWARDED_SPLIT_AND_SLICE.forwarded,
			"placement-layout-forwarded.js",
		);
		expect(semanticPlanShape(forwarded)).toEqual(semanticPlanShape(baseline));
		expect(semanticVmShape(lower(forwarded))).toEqual(semanticVmShape(lower(baseline)));
	});

	it("carries exact String.split producers through the compiler artifact", () => {
		const definition = lower(optimize(SPLIT_AND_SLICE, "split-producers.js"));
		const functionIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.some(({ kind }) => kind === "string-split-projection"),
		);
		const region = definition.native.functions[functionIndex]!.specializations.find(
			(candidate) => candidate.kind === "string-split-projection",
		);
		if (region?.kind !== "string-split-projection") {
			throw new Error("missing String.split projection");
		}
		const bytecode = definition.runtime.functions[functionIndex]!;
		expect(bytecode.instructions[region.separatorIp]?.opcode).toBe("CREATE_STRING");
		const element = region.loads.find((load) => load.kind === "element");
		if (element?.kind !== "element") throw new Error("missing projected element");
		expect(bytecode.instructions[element.keyIp]?.opcode).toBe("CREATE_NUMBER");
		expect(bytecode.instructions[element.ip]?.opcode).toBe("LOAD_PROPERTY");
		const key = bytecode.instructions[element.keyIp];
		const load = bytecode.instructions[element.ip];
		if (key?.opcode !== "CREATE_NUMBER" || load?.opcode !== "LOAD_PROPERTY") {
			throw new Error("invalid String.split producer instructions");
		}
		expect(key.dst).toBe(load.key);
		expect(key.value).toBe(element.index);
		expect(
			vmRegions(deserializeCompilerArtifact(serializeCompilerArtifact(definition))),
		).toEqual(vmRegions(definition));
		const owner = definition.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.indexOf(region);
		expect(() =>
			serializeCompilerArtifact(
				withVmRegion(definition, functionIndex, regionIndex, {
					...region,
					loads: region.loads.map((candidate) =>
						candidate === element ? { ...candidate, keyIp: candidate.ip } : candidate,
					),
				}),
			),
		).toThrow(/invalid String\.split projection region/);
	});

	it("rejects an invalid placement value in a Core plan", () => {
		const compilation = optimize(SPLIT_AND_SLICE, "placement-invalid.js");
		const specializations = projectCoreSpecializationRecipes(compilation.plan.recipes);
		const index = specializations.findIndex(
			(selection) => selection.kind === "string-slice-number",
		);
		const selection = specializations[index];
		if (selection?.kind !== "string-slice-number") throw new Error("missing slice plan");
		const invalid: CoreOptimizationPlan = {
			...compilation.plan,
			recipes: buildCoreSpecializationRecipeTable(
				specializations.with(index, {
					...selection,
					stringSliceNumber: {
						...selection.stringSliceNumber,
						propertyPlacement: "wherever" as never,
					},
				}),
			),
		};
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/invalid String\.slice Number certificate|property placement/,
		);
	});

	it("rejects a deferred placement whose producer is not the call's only consumer", () => {
		const compilation = optimize(SPLIT_AND_SLICE, "placement-consumer.js");
		const specializations = projectCoreSpecializationRecipes(compilation.plan.recipes);
		const index = specializations.findIndex(
			(selection) => selection.kind === "string-split-projection",
		);
		const selection = specializations[index];
		if (selection?.kind !== "string-split-projection") {
			throw new Error("missing split projection plan");
		}
		const foreign = selection.claimedInstructions.find(
			(instruction) => instruction !== selection.stringSplitProjection.call,
		)!;
		const invalid: CoreOptimizationPlan = {
			...compilation.plan,
			recipes: buildCoreSpecializationRecipeTable(
				specializations.with(index, {
					...selection,
					stringSplitProjection: {
						...selection.stringSplitProjection,
						call: foreign,
					},
				}),
			),
		};
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/invalid String\.split projection certificate/,
		);
	});

	it("rejects a deferred placement without locked identity at the Core boundary", () => {
		const compilation = optimize(
			`globalThis.first = function first(value) {
				const fields = value.split(";");
				return fields[0];
			};`,
			"placement-unlocked.js",
			"mutable",
		);
		const specializations = projectCoreSpecializationRecipes(compilation.plan.recipes);
		const index = specializations.findIndex(
			(selection) => selection.kind === "string-split-projection",
		);
		const selection = specializations[index];
		if (selection?.kind !== "string-split-projection")
			throw new Error("missing split plan");
		expect(selection.stringSplitProjection.propertyPlacement).toBe("in-place");
		const invalid: CoreOptimizationPlan = {
			...compilation.plan,
			recipes: buildCoreSpecializationRecipeTable(
				specializations.with(index, {
					...selection,
					stringSplitProjection: {
						...selection.stringSplitProjection,
						propertyPlacement: "call-fallback",
					},
				}),
			),
		};
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/invalid String\.split projection certificate/,
		);
	});

	it("round-trips placement through the wire form and rejects an invalid tag", () => {
		const definition = lower(optimize(SPLIT_AND_SLICE, "placement-wire.js"));
		const placements = vmRegions(definition).map(
			(region) => (region as { propertyPlacement?: string }).propertyPlacement,
		);
		expect(placements).toContain("call-fallback");
		const bytes = serializeCompilerArtifact(definition, { debugInfo: false });
		const restored = deserializeCompilerArtifact(bytes);
		expect(vmRegions(restored)).toEqual(vmRegions(definition));

		const functionIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.some(({ kind }) => kind === "string-slice-number"),
		);
		const owner = definition.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			({ kind }) => kind === "string-slice-number",
		);
		const region = owner.specializations[regionIndex];
		if (region?.kind !== "string-slice-number") throw new Error("missing slice region");
		const alternate = serializeCompilerArtifact(
			withVmRegion(definition, functionIndex, regionIndex, {
				...region,
				propertyPlacement: "in-place",
			}),
			{ debugInfo: false },
		);
		const differing = [...bytes].flatMap((byte, index) =>
			byte === alternate[index] ? [] : [index],
		);
		expect(differing).toHaveLength(1);
		const corrupted = Uint8Array.from(bytes);
		corrupted[differing[0]!] = 2;
		expect(() => deserializeCompilerArtifact(corrupted)).toThrow(
			/invalid region property placement/,
		);
	});
});

describe("late plan migration gates", () => {
	it("does not create an indexed length plan for a one-shot comparison", () => {
		const compilation = optimize(
			`globalThis.before = function before(index, values) {
				return index < values.length;
			};`,
			"core-one-shot-array-length.js",
		);
		expect(
			projectCoreSpecializationRecipes(compilation.plan.recipes).some(
				({ kind }) => kind === "indexed-length-loop",
			),
		).toBe(false);
	});

	it("keeps indexed loops with iterator cleanup on the ordinary lowering path", () => {
		const compilation = optimize(
			`globalThis.fill = function fill(groups) {
			for (const values of groups) {
				for (let index = 0; index < values.length; index++) values[index] = index;
			}
		};`,
			"core-indexed-loop-cleanup.js",
		);
		expect(
			projectCoreSpecializationRecipes(compilation.plan.recipes).some(
				({ kind }) => kind === "indexed-length-loop",
			),
		).toBe(false);
		expect(() => lower(compilation)).not.toThrow();
	});

	it("does not overlap indexed length plans with known own-slot loads", () => {
		const compilation = optimize(
			`globalThis.fill = function fill() {
				const values = { length: 4 };
				for (let index = 0; index < values.length; index++) {
					values[index] = index;
				}
				return values[3];
			};`,
			"core-known-own-length.js",
		);
		expect(
			projectCoreSpecializationRecipes(compilation.plan.recipes).some(
				({ kind }) => kind === "indexed-length-loop",
			),
		).toBe(false);
		expect(() =>
			lowerExecutionToProgramImage(lowerCoreCompilationToExecution(compilation)),
		).not.toThrow();
	});

	it.each([
		["length on the left", "values.length > index", 1, true],
		["non-strict inequality", "index != values.length", 2, false],
		["strict inequality", "index !== values.length", 2, false],
		["inclusive comparison", "index <= values.length", 2, false],
	] as const)(
		"certifies %s indexed loop tests",
		(_name, condition, lengthPosition, arrayIndexIsUint32) => {
			const compilation = optimize(
				`globalThis.visit = function visit(values) {
				let total = 0;
				for (let index = 0; ${condition}; index++) {
					total += values[index];
					if (index > 8) break;
				}
				return total;
			};`,
				"core-array-length-orientation.js",
			);
			const selection = projectCoreSpecializationRecipes(compilation.plan.recipes).find(
				(candidate) => candidate.kind === "indexed-length-loop",
			);
			if (selection?.kind !== "indexed-length-loop") {
				throw new Error("missing indexed-length plan");
			}
			expect(selection.indexedLengthLoop).toMatchObject({
				lengthPosition,
				receiverIsArray: false,
				elements: [{ kind: "load", arrayIndexIsUint32 }],
			});
		},
	);

	it("certifies literal Array identity through aliases", () => {
		const compilation = optimize(
			`globalThis.visit = function visit() {
				const values = [1, 2, 3];
				const alias = values;
				let total = 0;
				for (let index = 0; index < alias.length; index++) total += alias[index];
				return total;
			};`,
			"core-literal-array-length.js",
		);
		const selection = projectCoreSpecializationRecipes(compilation.plan.recipes).find(
			(candidate) => candidate.kind === "indexed-length-loop",
		);
		if (selection?.kind !== "indexed-length-loop") {
			throw new Error("missing indexed-length plan");
		}
		expect(selection.indexedLengthLoop.receiverIsArray).toBe(true);
	});

	it("does not certify joined or proxied receivers as literal Arrays", () => {
		for (const [name, setup] of [
			["join", "const receiver = flag ? [1, 2] : { 0: 1, 1: 2, length: 2 };"],
			["proxy", "const receiver = new Proxy([1, 2], {});"],
		] as const) {
			const compilation = optimize(
				`globalThis.visit = function visit(flag) {
					${setup}
					let total = 0;
					for (let index = 0; index < receiver.length; index++) total += receiver[index];
					return total;
				};`,
				`core-${name}-array-length.js`,
			);
			const selection = projectCoreSpecializationRecipes(compilation.plan.recipes).find(
				(candidate) => candidate.kind === "indexed-length-loop",
			);
			if (selection?.kind !== "indexed-length-loop") {
				throw new Error(`missing ${name} indexed-length plan`);
			}
			expect(selection.indexedLengthLoop.receiverIsArray).toBe(false);
		}
	});

	it.each([
		["negative seed", "-1", "index++"],
		["fractional seed", "0.5", "index++"],
		["non-unit update", "0", "index += 2"],
	] as const)("does not certify %s as an Array index", (_name, initial, update) => {
		const compilation = optimize(
			`globalThis.visit = function visit(values) {
				let total = 0;
				for (let index = ${initial}; index < values.length; ${update}) {
					total += values[index];
					if (index > 8) break;
				}
				return total;
			};`,
			"core-array-index-domain.js",
		);
		const selection = projectCoreSpecializationRecipes(compilation.plan.recipes).find(
			(candidate) => candidate.kind === "indexed-length-loop",
		);
		if (selection?.kind !== "indexed-length-loop") {
			throw new Error("missing indexed-length plan");
		}
		expect(selection.indexedLengthLoop.elements).toMatchObject([
			{ kind: "load", arrayIndexIsUint32: false },
		]);
	});

	it("does not create an indexed length plan for a wrapping update", () => {
		const compilation = optimize(
			`globalThis.visit = function visit(values) {
				let total = 0;
				for (let index = 0; index < values.length; index = (index + 1) | 0) {
					total += values[index];
					if (index > 8) break;
				}
				return total;
			};`,
			"core-array-index-wrapping.js",
		);
		expect(
			projectCoreSpecializationRecipes(compilation.plan.recipes).some(
				(candidate) => candidate.kind === "indexed-length-loop",
			),
		).toBe(false);
	});

	it("preserves a dense-fill reserve when its exit is the next loop header", () => {
		const compilation = optimize(
			`globalThis.fillAndRead = function fillAndRead() {
				let total = 0;
				for (let outer = 0; outer < 8; outer++) {
					const values = [];
					for (let index = 0; index < 32; index++) values[index] = index;
					for (let index = 0; index < 32; index++) total += values[index];
				}
				return total;
			};`,
			"core-dense-fill-consecutive-loops.js",
		);
		const dense = projectCoreSpecializationRecipes(compilation.plan.recipes).find(
			(selection) => selection.kind === "dense-array-plan",
		);
		if (dense?.kind !== "dense-array-plan") throw new Error("missing dense plan");
		expect(dense.denseArray.length).toBe(32);
		const execution = lowerCoreCompilationToExecution(compilation);
		expect(
			execution.functions
				.flatMap(({ blocks }) => blocks)
				.flatMap(({ instructions }) => instructions)
				.find(
					(instruction) =>
						instruction.type === "createArray" &&
						instruction.freshDenseReserveLength === 32,
				),
		).toBeDefined();
	});

	it("converges exact fresh-array builtin selection through CFG cleanup", () => {
		const compilation = optimize(
			`function pushPop(value) {
				const values = [];
				try {
					values.push(value);
					return values.pop();
				} catch (error) {
					return 0;
				}
			}
			globalThis.result = pushPop(globalThis.value);`,
			"core-array-or-numeric-typed-array-cleanup.js",
		);
		const operations = [...compilation.program.functionIds()].flatMap((functionId) => {
			const fn = compilation.program.function(functionId);
			return [...fn.instructionIds()].flatMap((instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "callKnown"
					? [fn.instructionAttributes(instruction).operation]
					: [],
			);
		});
		expect(operations).toEqual(
			expect.arrayContaining(["Array.prototype.push", "Array.prototype.pop"]),
		);
	});

	it("rejects a stack object that enters a mixed-value join", () => {
		const compilation = optimize(
			`globalThis.choose = function choose(value, useObject) {
				let result = value;
				if (useObject) result = { kind: "chosen", value };
				return result;
			};`,
			"core-stack-object-mixed-join.js",
		);
		expect(
			projectCoreSpecializationRecipes(compilation.plan.recipes).some(
				({ kind }) => kind === "stack-object-plan",
			),
		).toBe(false);
	});
});
