import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_CONTROL_FLOW_ANALYSIS } from "../src/compiler/core/core-ir-control-flow.ts";
import { CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS } from "../src/compiler/core/core-ir-interprocedural-flow.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
} from "../src/compiler/core/core-ir-memory.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
	analyzeCoreProvenance,
	discoverCoreLocalSpecializationCandidates,
} from "../src/compiler/core/core-ir-provenance.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "memory-passes.js",
		moduleEvaluationOrder: ["memory-passes.js"],
		sourceFiles: [{ path: "memory-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

const lockedContext: CoreCompilationContext = {
	...context,
	facts: {
		...context.facts,
		world: { ...context.facts.world, primordialPolicy: "locked" },
	},
};

function program(): CoreProgram {
	return new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [
			[0x78],
			[0x79],
			[0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68],
		],
	});
}

describe("Core local memory, provenance, and escape optimization", () => {
	it("classifies exact own slots and scalar-replaces a contained shaped object", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const loadDefinition = fn.valueDefinition(loaded!);
		if (loadDefinition.kind !== "instruction") throw new Error("Expected load result");
		const provenance = analyzeCoreProvenance(core, finished.function);
		const access = coreMemoryAccesses(fn, loadDefinition.instruction, {
			ownCell(base, key, mode) {
				const resolved = provenance.ownCell(base, key, mode);
				return resolved === undefined ? undefined : { allocation: resolved.layout.instruction, cell: resolved.cell };
			},
		})[0]!;
		expect(coreMemoryLocationIsExact(access.location)).toBe(true);
		expect(provenance.escape(provenance.layouts[0]!.instruction)).toBe("contained");

		const optimized = optimizeCore({ program: core, context });
		const opcodes = [...optimized.compilation.program.function(finished.function).instructionIds()]
			.filter((instruction) => optimized.compilation.program.function(finished.function).instructionKind(instruction) === "operation")
			.map((instruction) => optimized.compilation.program.function(finished.function).instructionOpcodeName(instruction));
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).not.toContain("createObjectShaped");
		expect(optimized.report.discovery).toMatchObject({
			candidates: 1,
			stackObjects: 1,
			largestFanOut: 1,
		});
	});

	it("retains the boxing move when forwarding an unboxed slot value", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);

		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		const move = [...fn.instructionIds()].find((instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "move",
		);
		expect(move).toBeDefined();
		expect(fn.valueRepresentation(fn.instructionResults(move!)[0]!)).toBe("boxed");
		expect(fn.valueRepresentation(fn.instructionOperands(move!)[0]!)).toBe("f64");
	});

	it("does not merge conflicting branch memory versions", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [two] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 2 } });
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.appendInstruction(left, "storePropertyStatic", [object!, two!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(left, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.setTerminator(right, { kind: "jump", edge: { block: merge, arguments: [] } });
		const [loaded] = builder.appendInstruction(merge, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(merge, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		expect([...fn.instructionIds()].filter((instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadPropertyStatic",
		)).toHaveLength(1);
	});

	it("flattens forwarding chains before deleting their intermediate loads", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [first] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.appendInstruction(entry, "storePropertyStatic", [object!, first!], {
			attributes: { stringIndex: 0 },
		});
		const [second] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: second! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		expect([...fn.instructionIds()].filter((instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadPropertyStatic",
		)).toHaveLength(0);
	});

	it("widens an out-of-layout alias to family memory and marks the object escaped", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [key] = builder.appendInstruction(entry, "createString", [], { attributes: { stringIndex: 1 } });
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadProperty", [object!, key!]);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const definition = fn.valueDefinition(loaded!);
		if (definition.kind !== "instruction") throw new Error("Expected load result");
		const provenance = analyzeCoreProvenance(core, finished.function);
		expect(provenance.escape(provenance.layouts[0]!.instruction)).toBe("escaped");
		expect(coreMemoryAccesses(fn, definition.instruction, {
			ownCell(base, accessKey, mode) {
				const resolved = provenance.ownCell(base, accessKey, mode);
				return resolved === undefined ? undefined : { allocation: resolved.layout.instruction, cell: resolved.cell };
			},
		})[0]!.location).toEqual({ kind: "family", family: "object-slot" });
	});

	it("keeps weakly holdable values rooted by an otherwise removable aggregate", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const held = builder.blockParameters(entry)[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [held], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		expect([...fn.instructionIds()].some((instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "createObjectShaped",
		)).toBe(true);
	});

	it("refines a locally contained collection receiver under locked primordials", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [constructor] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Map" },
		});
		const [map] = builder.appendInstruction(entry, "construct", [constructor!]);
		const [key] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [has] = builder.appendInstruction(entry, "callBuiltin", [map!, key!], {
			attributes: { operation: "Map.prototype.has" },
		});
		builder.setTerminator(entry, { kind: "return", value: has! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program: core, context: lockedContext });
		const fn = optimized.compilation.program.function(finished.function);
		const call = [...fn.instructionIds()].find((instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "callBuiltin",
		);
		expect(call).toBeDefined();
		expect(fn.instructionAttributes(call!).exactCollectionReceiver).toBe("Map");
		const refinement = fn.instructionEffectRefinement(call!);
		expect(refinement).toBeDefined();
		expect(fn.fact(refinement!.proof).kind).toBe("exact-collection-builtin-effects");
	});

	it("invalidates memory facts without invalidating CFG or local call topology", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const definition = fn.valueDefinition(loaded!);
		if (definition.kind !== "instruction") throw new Error("Expected load result");
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, context, report);
		const request = { scope: "function", function: finished.function } as const;
		const cfg = analyses.get(CORE_CONTROL_FLOW_ANALYSIS, request);
		const calls = analyses.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request);
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request);
		const candidates = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, request);
		const editor = CoreEditor.open(core, finished.function);
		const effects = {
			reads: ["object-property"], writes: [], mayThrow: false,
			maySuspend: false, mayGc: false, callsUserCode: false,
		} as const;
		const proof = editor.addFact({
			kind: "test-memory-refinement",
			value: true,
			claims: [{ kind: "effect", instruction: definition.instruction, effects }],
			validity: { kind: "asserted", source: "test" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(definition.instruction, { effects, proof });
		const changes = editor.commit();
		expect(changes.domains).not.toContain("cfg");
		expect(changes.domains).not.toContain("calls");
		expect(analyses.get(CORE_CONTROL_FLOW_ANALYSIS, request)).toBe(cfg);
		expect(analyses.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request)).toBe(calls);
		expect(analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request)).not.toBe(memory);
		expect(analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, request)).not.toBe(candidates);
	});

	it("deduplicates immutable discovery records by stable ID", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 }, outputRepresentations: ["f64"],
		});
		const [object] = builder.appendInstruction(entry, "createArray", [], { attributes: { length: 0 } });
		const [sum] = builder.appendInstruction(entry, "mathBinaryNumber", [one!, one!], {
			attributes: { operator: "+" }, outputRepresentations: ["f64"],
		});
		const [next] = builder.appendInstruction(entry, "mathUnaryNumber", [sum!], {
			attributes: { operator: "increment" }, outputRepresentations: ["f64"],
		});
		builder.appendInstruction(entry, "rootUse", [object!]);
		builder.setTerminator(entry, { kind: "return", value: next! });
		const finished = builder.finish(entry);
		const discovery = discoverCoreLocalSpecializationCandidates(core, finished.function);
		expect(new Set(discovery.candidates.map(({ key }) => key)).size).toBe(discovery.candidates.length);
		expect(Object.isFrozen(discovery.candidates)).toBe(true);
		const dense = discovery.candidates.find(({ kind }) => kind === "dense-array");
		expect(dense?.allocation).toBeTypeOf("number");
		expect(discovery.candidates.some(({ kind }) => kind === "numeric-fusion")).toBe(true);
	});
});
