import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	corePlanAdmissionMode,
	verifyCoreOptimizationPlan,
} from "../src/compiler/core/core-ir-region-validity.ts";
import type {
	CoreOptimizationPlan,
	CorePlanSpecialization,
} from "../src/compiler/core/core-ir-regions.ts";
import type { CoreBlockId, CoreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import type { CompilerGuardPlan } from "../src/compiler/shared/compiler-facts.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import type { ProgramImage, VmRegion } from "../src/compiler/target/program-image.ts";

const REGION_SOURCE = `globalThis.first = function first(value) {
	const fields = value.split(";");
	return fields[0];
};`;

const MULTI_REGION_SOURCE = `globalThis.run = function run(value, separator) {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		total += parts[index].trim().length;
	}
	const fields = value.split(";");
	const match = /(\\d+)x/.exec(value);
	return total + Number(fields[1].slice(2)) + fields.length +
		(match === null ? 0 : Number(match[1]));
};
globalThis.iterate = function iterate(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
};`;

function compileSource(
	source: string,
	primordials: "locked" | "mutable",
): CoreCompilation {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		`region-validity-${primordials}.js`,
		parseScript(source, { strict: false }),
	);
	return optimizeSemanticProgramToCore(
		semantic,
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
		(_phase, run) => run(),
	);
}

function compile(primordials: "locked" | "mutable"): CoreCompilation {
	return compileSource(REGION_SOURCE, primordials);
}

function guardDependencies(
	selection: CorePlanSpecialization,
): ReadonlyArray<{ readonly kind: string }> {
	switch (selection.kind) {
		case "string-split-cursor":
			return selection.stringSplitCursor.guard.dependencies;
		case "string-split-projection":
			return selection.stringSplitProjection.guard.dependencies;
		case "string-slice-number":
			return selection.stringSliceNumber.guard.dependencies;
		case "regexp-exec-projection":
			return selection.regexpExecProjection.guard.dependencies;
		case "regexp-iterator-projection":
			return selection.regexpIteratorProjection.guard.dependencies;
		case "string-char-code-at-chain":
			return selection.stringCharCodeAt.guard.dependencies;
		case "builtin-collection-call-chain":
			return selection.builtinCollectionCall.guard.dependencies;
		case "iterator-result-virtualization":
			return selection.iteratorResultVirtualization.guard.dependencies;
		case "iterator-entry-pair-virtualization":
			return selection.iteratorEntryPairVirtualization.guard.dependencies;
		default:
			return [];
	}
}

function splitProjection(compilation: CoreCompilation): {
	readonly index: number;
	readonly selection: Extract<
		CorePlanSpecialization,
		{ kind: "string-split-projection" }
	>;
} {
	const index = compilation.plan.specializations.findIndex(
		({ kind }) => kind === "string-split-projection",
	);
	const selection = compilation.plan.specializations[index];
	if (selection?.kind !== "string-split-projection") {
		throw new Error("missing String.split projection plan");
	}
	return { index, selection };
}

function withSelection(
	compilation: CoreCompilation,
	index: number,
	selection: CorePlanSpecialization,
): CoreOptimizationPlan {
	return {
		...compilation.plan,
		specializations: compilation.plan.specializations.with(index, selection),
	};
}

function withSplitGuard(
	selection: Extract<CorePlanSpecialization, { kind: "string-split-projection" }>,
	guard: CompilerGuardPlan,
): Extract<CorePlanSpecialization, { kind: "string-split-projection" }> {
	return {
		...selection,
		stringSplitProjection: { ...selection.stringSplitProjection, guard },
	};
}

function lower(compilation: CoreCompilation): ProgramImage {
	return lowerExecutionToProgramImage(lowerCoreCompilationToExecution(compilation));
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

describe("Core plan admission modes", () => {
	it("keeps a locked-world license stable and re-checks an invalidatable one per use", () => {
		const locked = compileSource(MULTI_REGION_SOURCE, "locked").plan.specializations;
		const mutable = compileSource(MULTI_REGION_SOURCE, "mutable").plan.specializations;
		const kinds = new Set([...locked, ...mutable].map(({ kind }) => kind));
		for (const expected of [
			"string-split-cursor",
			"regexp-exec-projection",
			"string-slice-number",
			"array-values-iterator-cursor",
			"iterator-result-virtualization",
			"numeric-fusion",
		]) {
			expect(kinds.has(expected as never)).toBe(true);
		}
		expect(locked.length).toBeGreaterThan(0);
		for (const selection of locked) expect(selection.admission.mode).toBe("stable");
		const invalidatable = mutable.filter((selection) =>
			guardDependencies(selection).some(({ kind }) => kind === "epoch"),
		);
		expect(invalidatable.length).toBeGreaterThan(0);
		for (const selection of invalidatable) {
			expect(selection.admission.mode).toBe("per-use");
		}
		for (const selection of mutable.filter(
			(candidate) => !invalidatable.includes(candidate),
		)) {
			expect(selection.admission.mode).toBe("stable");
		}
	});

	it("rejects a stable claim over an interior that runs user code", () => {
		const compilation = compile("mutable");
		const { index, selection } = splitProjection(compilation);
		const invalid = withSelection(compilation, index, {
			...selection,
			admission: { ...selection.admission, mode: "stable" },
		});
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/claims stable admission where Core proves per-use/,
		);
	});

	it("rejects a license that names an epoch family no backend can lower", () => {
		const compilation = compile("mutable");
		const { index, selection } = splitProjection(compilation);
		const invalid = withSelection(
			compilation,
			index,
			withSplitGuard(selection, {
				...selection.stringSplitProjection.guard,
				dependencies: [{ kind: "epoch", family: "object-shapes" }],
			}),
		);
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/unlowerable epoch family object-shapes/,
		);
	});

	it("rejects a certificate with no admission record", () => {
		const compilation = compile("locked");
		const { index, selection } = splitProjection(compilation);
		const invalid = withSelection(compilation, index, {
			...selection,
			admission: undefined as never,
		});
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/invalid admission anchor/,
		);
	});

	it("rejects an unreadable license guard", () => {
		const compilation = compile("locked");
		const { index, selection } = splitProjection(compilation);
		const invalid = withSelection(
			compilation,
			index,
			withSplitGuard(selection, 7 as never),
		);
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/unreadable admission guard/,
		);
	});

	it("rejects a virtual result without its materialization obligation", () => {
		const compilation = compile("locked");
		const { index, selection } = splitProjection(compilation);
		const invalid = withSelection(
			compilation,
			index,
			withSplitGuard(selection, {
				...selection.stringSplitProjection.guard,
				obligations: selection.stringSplitProjection.guard.obligations.filter(
					(obligation) => obligation.kind !== "materialize",
				),
			}),
		);
		expect(() => verifyCoreOptimizationPlan(compilation.program, invalid)).toThrow(
			/materialization|invalid String\.split projection certificate/,
		);
	});

	it("carries the admission decision across wire serialization", () => {
		for (const primordials of ["locked", "mutable"] as const) {
			const definition = lower(compileSource(MULTI_REGION_SOURCE, primordials));
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(definition));
			expect(
				restored.native.functions.flatMap(({ specializations }) =>
					specializations.map(({ license }) => license.admission),
				),
			).toEqual(
				definition.native.functions.flatMap(({ specializations }) =>
					specializations.map(({ license }) => license.admission),
				),
			);
		}
	});

	it("rejects a wire admission anchor outside the region's claims", () => {
		const definition = lower(compile("locked"));
		const functionIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.some(({ kind }) => kind === "string-split-projection"),
		);
		const owner = definition.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			({ kind }) => kind === "string-split-projection",
		);
		const region = owner.specializations[regionIndex]!;
		const foreignIp = definition.runtime.functions[functionIndex]!.instructions.findIndex(
			(_instruction, instructionIp) => !region.claimedIps.includes(instructionIp),
		);
		expect(() =>
			serializeCompilerArtifact(
				withVmRegion(definition, functionIndex, regionIndex, {
					...region,
					license: {
						...region.license,
						admission: { ...region.license.admission, anchorIp: foreignIp },
					},
				} as VmRegion),
			),
		).toThrow(/invalid region envelope/);
	});
});

interface AdmissionProgram {
	readonly program: CoreProgram;
	readonly function: number;
	readonly anchor: CoreInstructionId;
	readonly use: CoreInstructionId;
	readonly ordinaryBlocks: ReadonlyArray<CoreBlockId>;
}

function straightLineAdmission(
	extra: (
		builder: CoreFunctionBuilder,
		block: CoreBlockId,
		anchor: CoreInstructionId,
	) => CoreInstructionId,
): AdmissionProgram {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const block = builder.createBlock();
	const [anchorValue] = builder.appendInstruction(block, "createF64", [], {
		attributes: { value: 1 },
		outputRepresentations: ["f64"],
	});
	const anchor = [...builder.bodyInstructionIds(block)][0]!;
	const use = extra(builder, block, anchor);
	builder.setTerminator(block, { kind: "return", value: anchorValue! });
	const { function: functionId } = builder.finish(block);
	return { program, function: functionId, anchor, use, ordinaryBlocks: [block] };
}

function admissionMode(built: AdmissionProgram): "capture" | "stable" | "per-use" {
	return corePlanAdmissionMode(
		built.program.function(built.function as never),
		buildCoreControlFlow(built.program, built.function as never),
		{
			anchor: built.anchor,
			dependencies: [{ kind: "epoch", family: "watched-methods" }],
			claimedInstructions: [built.anchor, built.use],
			ordinaryBlocks: built.ordinaryBlocks,
			exceptionalBlocks: [],
		},
	);
}

describe("Core plan admission interior proof", () => {
	it("accepts one admission over a scalar-only interior", () => {
		const built = straightLineAdmission((builder, block) => {
			const [left] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 2 },
				outputRepresentations: ["f64"],
			});
			const [right] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 3 },
				outputRepresentations: ["f64"],
			});
			builder.appendInstruction(block, "binary", [left!, right!], {
				attributes: { operator: "+" },
				outputRepresentations: ["f64"],
			});
			return [...builder.bodyInstructionIds(block)].at(-1)!;
		});
		expect(admissionMode(built)).toBe("stable");
	});

	it("rejects a licensed use before its same-block admission anchor", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
		const builder = new CoreFunctionBuilder(program, {
			metadata: { sourcePath: "/entry.js" },
		});
		const block = builder.createBlock();
		const [earlyValue] = builder.appendInstruction(block, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const early = [...builder.bodyInstructionIds(block)][0]!;
		builder.appendInstruction(block, "createF64", [], {
			attributes: { value: 2 },
			outputRepresentations: ["f64"],
		});
		const anchor = [...builder.bodyInstructionIds(block)][1]!;
		builder.setTerminator(block, { kind: "return", value: earlyValue! });
		const { function: functionId } = builder.finish(block);
		expect(
			admissionMode({
				program,
				function: functionId,
				anchor,
				use: early,
				ordinaryBlocks: [block],
			}),
		).toBe("per-use");
	});

	it("loses one admission when interior arithmetic can run a coercion hook", () => {
		const built = straightLineAdmission((builder, block) => {
			const [left] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 2 },
			});
			const [right] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 3 },
			});
			builder.appendInstruction(block, "binary", [left!, right!], {
				attributes: { operator: "+" },
			});
			return [...builder.bodyInstructionIds(block)].at(-1)!;
		});
		expect(admissionMode(built)).toBe("per-use");
	});

	it("loses one admission when the interior stores to a property", () => {
		const built = straightLineAdmission((builder, block) => {
			const [object] = builder.appendInstruction(block, "createObject", [], {
				attributes: { keyStringIndices: [] },
			});
			const [value] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 1 },
				outputRepresentations: ["f64"],
			});
			builder.appendInstruction(block, "storePropertyStatic", [object!, value!], {
				attributes: { stringIndex: 0 },
			});
			return [...builder.bodyInstructionIds(block)].at(-1)!;
		});
		expect(admissionMode(built)).toBe("per-use");
	});

	it("loses one admission when a licensed block is reachable without the anchor", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
		const builder = new CoreFunctionBuilder(program, {
			metadata: { sourcePath: "/entry.js" },
		});
		const entry = builder.createBlock();
		const bypass = builder.createBlock();
		const licensed = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const anchor = [...builder.bodyInstructionIds(entry)].at(-1)!;
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: licensed, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		builder.setTerminator(bypass, {
			kind: "jump",
			edge: { block: licensed, arguments: [] },
		});
		const [result] = builder.appendInstruction(licensed, "createUndefined", []);
		const use = [...builder.bodyInstructionIds(licensed)][0]!;
		builder.setTerminator(licensed, { kind: "return", value: result! });
		const { function: functionId } = builder.finish(entry);
		expect(
			admissionMode({
				program,
				function: functionId,
				anchor,
				use,
				ordinaryBlocks: [entry, licensed],
			}),
		).toBe("per-use");
	});
});
