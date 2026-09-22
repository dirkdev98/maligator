import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorEdges,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS } from "../src/compiler/core/core-ir-interprocedural-flow.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
} from "../src/compiler/core/core-ir-memory.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
	CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
	analyzeCoreProvenance,
	discoverCoreLocalSpecializationCandidates,
} from "../src/compiler/core/core-ir-provenance.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import { CORE_MEMORY_PASSES } from "../src/compiler/core/core-memory-passes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { builtinWorldAssumptions } from "../src/compiler/shared/builtin-assumptions.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreInstructionOperands,
	inspectCoreInstructionResults,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

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
		stringConstants: [[0x78], [0x79], [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68]],
	});
}

describe("Core local memory, provenance, and escape optimization", () => {
	it("does not request memory versions for repeated memory-free operations", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 7 } });
		const [result] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = core.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;
		new CoreFunctionPassScheduler(core, context, analyses, report, fn.id).runComponent(
			"memory",
			[forwarding],
		);
		expect(
			report
				.finish(core, { directEntries: [], specializations: [] })
				.analyses.some(({ analysis }) => analysis === "local-memory-versions"),
		).toBe(false);
	});

	it("solves only the repeated slot among many unrelated reads", () => {
		const core = new CoreProgram(coreOpcodeRegistry, { globalCount: 300 });
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const values = Array.from(
			{ length: 300 },
			(_, index) =>
				builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index } })[0]!,
		);
		const [repeated] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: repeated! });
		const fn = core.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;
		new CoreFunctionPassScheduler(core, context, analyses, report, fn.id, {
			optionalMaxRunsPerWorkItem: 1,
		}).runComponent("memory", [forwarding]);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "return",
			value: values[0],
		});
		const result = report.finish(core, { directEntries: [], specializations: [] });
		expect(result.counters.memoryPartitionsSolved).toBe(2);
		expect(result.counters.memoryAccesses).toBe(301);
	});

	it("counts lazy memory work once even when the same proof is queried repeatedly", () => {
		const core = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const fn = core.function(builder.finish(entry).function);
		const read = builder.bodyInstructionIds(entry)[0]!;
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, {
			scope: "function",
			function: fn.id,
		});
		expect(memory.statistics.accesses).toBe(0);
		expect(memory.readHash(read)).toBeDefined();
		const before = memory.statistics;
		expect(memory.readsEquivalent(read, read)).toBe(true);
		memory.valueForRead(read, { kind: "global-slot", slot: 0 });
		expect(memory.statistics).toEqual(before);
		const result = report.finish(core, { directEntries: [], specializations: [] });
		expect(result.counters.memoryPartitionsSolved).toBe(before.solvedPartitions);
		expect(result.counters.memoryStateEntries).toBe(before.stateEntries);
		expect(result.counters.memoryAccesses).toBe(1);
	});

	it("forwards an exact global without proving unrelated heap allocations", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		for (let index = 0; index < 100; index++) {
			const [object] = builder.appendInstruction(entry, "createObjectShaped", [stored!], {
				attributes: { keyStringIndices: [0] },
			});
			builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
		}
		builder.appendInstruction(entry, "storeGlobal", [stored!], {
			attributes: { index: 0 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const read = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const fn = builder.finish(entry).function;
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, {
			scope: "function",
			function: fn,
		});
		expect(memory.valueForRead(read, { kind: "global-slot", slot: 0 })).toBe(stored);
		expect(memory.statistics.heapAccessesResolved).toBe(0);
		const result = report.finish(core, { directEntries: [], specializations: [] });
		expect(result.analyses.some(({ analysis }) => analysis === "local-fact-bundle")).toBe(
			false,
		);
		expect(result.counters.provenanceEscapeChecks).toBe(0);
	});

	it("proves only queried heap allocations and reuses their proofs", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const queries = Array.from({ length: 100 }, () => {
			const [object] = builder.appendInstruction(entry, "createObjectShaped", [stored!], {
				attributes: { keyStringIndices: [0] },
			});
			const allocation = builder.bodyInstructionIds(entry).at(-1)!;
			builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
			return { allocation, read: builder.bodyInstructionIds(entry).at(-1)! };
		});
		builder.setTerminator(entry, { kind: "return", value: stored! });
		const fn = builder.finish(entry).function;
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, {
			scope: "function",
			function: fn,
		});
		for (const [index, demanded] of [
			[0, 1],
			[1, 2],
			[0, 2],
		] as const) {
			const { allocation, read } = queries[index]!;
			expect(memory.valueForRead(read, { kind: "object-slot", allocation, key: 0 })).toBe(
				stored,
			);
			const result = report.finish(core, { directEntries: [], specializations: [] });
			expect(result.counters.provenanceLayoutsMaterialized).toBe(demanded);
			expect(result.counters.provenanceEscapeChecks).toBe(demanded);
			expect(memory.statistics.heapAccessesResolved).toBe(demanded);
			expect(memory.statistics.events).toBe(demanded * 2);
		}
	});

	it("keeps reads with no modeled memory location across a clobber", () => {
		const registry = new CoreOpcodeRegistry();
		registry.define({
			opcode: "unmodeledRead",
			inputs: coreArity(0),
			outputs: coreArity(1),
			effects: { ...CORE_NO_EFFECTS, reads: ["object-property"] },
			discardable: true,
			attributeRelocations: [],
		});
		registry.define({
			opcode: "clobber",
			discardable: false,
			inputs: coreArity(0),
			outputs: coreArity(0),
			effects: { ...CORE_NO_EFFECTS, writes: ["object-property"] },
			attributeRelocations: [],
		});
		const core = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "unmodeledRead", []);
		builder.appendInstruction(entry, "clobber", []);
		const [loaded] = builder.appendInstruction(entry, "unmodeledRead", []);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const fn = core.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(core, "full");
		const analyses = new CoreAnalysisManager(core, context, report);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;
		new CoreFunctionPassScheduler(core, context, analyses, report, fn.id).runComponent(
			"memory",
			[forwarding],
		);
		expect(
			[...fn.bodyInstructionIds(entry)].filter(
				(i) => fn.instructionOpcodeName(i) === "unmodeledRead",
			),
		).toHaveLength(2);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "return",
			value: loaded,
		});
	});

	it("batches repeated reads while preserving a load after a clobber", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const loaded = [0, 0, 0, 1, 1].map(
			(index) =>
				builder.appendInstruction(entry, "loadGlobal", [], {
					attributes: { index },
				})[0]!,
		);
		builder.appendInstruction(entry, "storeGlobal", [replacement!], {
			attributes: { index: 0 },
		});
		const [afterStore] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		for (const value of [...loaded, afterStore!]) {
			builder.appendInstruction(entry, "storeGlobal", [value], {
				attributes: { index: 1 },
			});
		}
		builder.setTerminator(entry, { kind: "return", value: afterStore! });
		const fn = program.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;
		new CoreFunctionPassScheduler(program, context, analyses, report, fn.id, {
			optionalMaxRunsPerWorkItem: 1,
			verification: "per-pass",
		}).runComponent("memory", [forwarding]);
		const stored = [...fn.bodyInstructionIds(entry)]
			.filter(
				(instruction) =>
					fn.instructionOpcodeName(instruction) === "storeGlobal" &&
					fn.instructionAttributes(instruction).index === 1,
			)
			.map((instruction) => inspectCoreInstructionOperands(fn, instruction)[0]);
		expect(stored).toEqual([
			loaded[0],
			loaded[0],
			loaded[0],
			loaded[3],
			loaded[3],
			afterStore,
		]);
	});

	it.each([false, true])(
		"does not infer own properties from empty-object guard operands: %s",
		(guarded) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core);
			const entry = builder.createBlock();
			const [guard] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [object] = builder.appendInstruction(
				entry,
				"createObject",
				guarded ? [guard!] : [],
			);
			const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const finished = builder.finish(entry);
			const provenance = analyzeCoreProvenance(core, finished.function);
			expect(provenance.allocationOf(object!)).toMatchObject({
				kind: "named-slots",
				keys: [],
				initialValues: [],
			});
			expect(
				provenance.ownCell(object!, { kind: "string-constant", index: 0 }, "read"),
			).toBeUndefined();
		},
	);
	it.each([
		["new Boolean(!!x)", "Boolean", "Boolean"],
		["new Number((+x) | 0)", "Number", "Number"],
		["new Number(+x)", "Number", "Number"],
		["new String(String(x))", "String", "String"],
		["Object(!!x)", "Object", "Boolean"],
		["new Object(+x)", "Object", "Number"],
		["Object(String(x))", "Object", "String"],
		["new Boolean(x)", "Boolean", "Boolean"],
		["new Number(x)", "Number", "Number"],
		["new String(x)", "String", "String"],
	] as const)(
		"materializes %s only at its conditional identity consumer when its input is safe",
		(expression, operation, brand) => {
			const result = inspectStaticValueFunction(
				`function delayed(x, flag) {
					const box = ${expression};
					if (flag) globalThis.sink = box;
					return ${brand}.prototype.valueOf.call(box);
				} globalThis.run = delayed;`,
				"delayed",
			);
			const allocation = result.core.find(
				(op) =>
					op.opcode === "callKnown" &&
					op.attributes.operation === operation &&
					(operation === "Object" || op.attributes.construct),
			);
			const escape = result.core.find((op) => op.opcode === "storePropertyStatic");
			expect(allocation).toBeDefined();
			expect(escape).toBeDefined();
			expect(allocation!.block).toBe(escape!.block);
		},
	);

	it.each(
		["shaped", "Boolean", "Number", "String", "Object", "new Object"].flatMap(
			(allocation) =>
				[
					"conditional",
					"loop",
					"weak-field",
					"handler",
					"source-use",
					"suspend",
					"mutable",
					"realm",
					"new-target",
					"weak-extra",
				].map((scenario) => ({ allocation, scenario })),
		),
	)(
		"only sinks $allocation without identity or lifetime hazards: $scenario",
		({ allocation, scenario }) => {
			const core = new CoreProgram(coreOpcodeRegistry, {
				globalCount: 1,
				stringConstants: [[0x78]],
			});
			const builder = new CoreFunctionBuilder(core, {
				parameterCount: 1,
				isAsync: scenario === "suspend",
			});
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const flag = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const used = builder.createBlock();
			const skipped = builder.createBlock();
			const [seven] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const operation = allocation === "new Object" ? "Object" : allocation;
			const [target] = builder.appendInstruction(entry, "loadIntrinsic", [], {
				attributes: { intrinsic: operation === "shaped" ? "Object" : operation },
			});
			const [undefinedValue] = builder.appendInstruction(entry, "createUndefined", []);
			const [text] = builder.appendInstruction(entry, "createString", [], {
				attributes: { stringIndex: 0 },
			});
			const payload =
				scenario === "weak-field" ? flag : allocation === "String" ? text! : seven!;
			const [object] =
				allocation === "shaped"
					? builder.appendInstruction(entry, "createObjectShaped", [payload], {
							attributes: { keyStringIndices: [0] },
						})
					: builder.appendInstruction(
							entry,
							"callKnown",
							[
								scenario === "new-target"
									? flag
									: allocation === "Object"
										? undefinedValue!
										: target!,
								payload,
								...(scenario === "weak-extra" ? [flag] : []),
							],
							{
								attributes: {
									operation,
									construct: allocation !== "Object",
									worldAssumptions: {
										...builtinWorldAssumptions(operation, "exact-builtin-proof"),
									},
								},
							},
						);
			if (scenario === "source-use") {
				builder.appendInstruction(entry, "rootUse", [object!]);
			}
			if (scenario === "suspend") builder.appendInstruction(entry, "await", [seven!]);
			builder.setTerminator(entry, {
				kind: "branch",
				condition: flag,
				consequent: { block: used, arguments: [] },
				alternate: { block: skipped, arguments: [] },
			});
			builder.appendInstruction(used, "storeGlobal", [object!], {
				attributes: { index: 0 },
			});
			if (scenario === "loop") {
				builder.setTerminator(used, {
					kind: "branch",
					condition: flag,
					consequent: { block: used, arguments: [] },
					alternate: { block: skipped, arguments: [] },
				});
			} else builder.setTerminator(used, { kind: "return", value: seven! });
			builder.setTerminator(skipped, { kind: "return", value: seven! });
			if (scenario === "handler") {
				const handler = builder.createBlock([
					{ representation: "boxed", role: "exception" },
				]);
				builder.setHandler(entry, handler, []);
				builder.setTerminator(handler, {
					kind: "return",
					value: inspectCoreBlockParameters(builder, handler)[0]!.value,
				});
			}
			const finished = builder.finish(entry);
			const fn = core.function(finished.function);
			const definition = inspectCoreValueDefinition(fn, object!);
			if (definition.kind !== "instruction") throw new Error("Expected allocation");
			const report = new CoreOptimizationReportBuilder(core);
			const compilationContext = {
				...context,
				facts: {
					...context.facts,
					world: {
						...context.facts.world,
						primordialPolicy:
							scenario === "mutable" ? ("mutable" as const) : ("locked" as const),
						realms: scenario === "realm",
					},
				},
			};
			const analyses = new CoreAnalysisManager(core, compilationContext, report);
			const pass = CORE_MEMORY_PASSES.find(
				({ name }) => name === "sink-conditional-object-allocations",
			)!;
			new CoreFunctionPassScheduler(core, compilationContext, analyses, report, fn.id, {
				verification: "per-pass",
			}).runComponent("memory", [pass]);
			expect(fn.instructionBlock(definition.instruction)).toBe(
				scenario === "conditional" ||
					(allocation === "shaped" &&
						["mutable", "realm", "new-target", "weak-extra"].includes(scenario))
					? used
					: entry,
			);
		},
	);

	it("skips allocation-observation provenance for unrelated values", () => {
		const core = new CoreProgram(coreOpcodeRegistry, {
			globalCount: 2,
			stringConstants: [[0x78]],
		});
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		builder.appendInstruction(entry, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 1 },
		});
		const [observed] = builder.appendInstruction(entry, "unary", [loaded!], {
			attributes: { operator: "typeof" },
		});
		builder.setTerminator(entry, { kind: "return", value: observed! });
		builder.finish(entry);

		const optimized = optimizeCore(
			{ program: core, context },
			{ instrumentation: "counters", mode: "full" },
		);

		expect(
			optimized.report.passes.find(
				({ pass }) => pass === "fold-exact-allocation-observations",
			),
		).toBeUndefined();
	});

	it("scalar-replaces operand-rooted shaped-object updates", () => {
		const source = `globalThis.update = function update(value) {
			const point = { x: value, y: value + 1 };
			point.x = point.x + point.y;
			return point.x;
		};`;
		const compilation = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				source,
				"operand-rooted-object.js",
				parseScript(source, { strict: false }),
			),
			{},
			(_phase, run) => run(),
		);
		const functionId = [...compilation.program.functionIds()].find(
			(candidate) => compilation.program.function(candidate).parameterCount === 1,
		)!;
		const fn = compilation.program.function(functionId);
		const opcodes = [...fn.instructionIds()].flatMap((instruction) =>
			fn.instructionKind(instruction) === "operation"
				? [fn.instructionOpcodeName(instruction)]
				: [],
		);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("storePropertyStatic");
	});

	it("preserves representation joins for destructuring defaults", () => {
		const source = `let count = 0;
		function fallback() { count += 1; }
		const { w = fallback(), x = fallback(), y = fallback(), z = fallback() } = {
			w: null,
			x: 0,
			y: false,
			z: "",
		};
		globalThis.result = [w, x, y, z, count];`;
		expect(() =>
			optimizeSemanticProgramToCore(
				analyzeSourceAndRunSemanticAnalysis(
					source,
					"destructuring-default.js",
					parseScript(source, { strict: false }),
				),
				{},
				(_phase, run) => run(),
			),
		).not.toThrow();
	});

	it("classifies exact own slots and scalar-replaces a contained shaped object", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const loadDefinition = inspectCoreValueDefinition(fn, loaded!);
		if (loadDefinition.kind !== "instruction") throw new Error("Expected load result");
		const objectDefinition = inspectCoreValueDefinition(fn, object!);
		if (objectDefinition.kind !== "instruction") {
			throw new Error("Expected shaped-object result");
		}
		const provenance = analyzeCoreProvenance(core, finished.function);
		const access = coreMemoryAccesses(fn, loadDefinition.instruction, {
			ownCell(base, key, mode) {
				const resolved = provenance.ownCell(base, key, mode);
				return resolved === undefined
					? undefined
					: { allocation: resolved.layout.instruction, cell: resolved.cell };
			},
		})[0]!;
		expect(coreMemoryLocationIsExact(access.location)).toBe(true);
		expect(provenance.escape(provenance.layouts[0]!.instruction)).toBe("contained");
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, context, report);
		const request = { scope: "function", function: finished.function } as const;
		const firstProofs = analyses.get(CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS, request);
		expect(firstProofs.proofs).toEqual([
			{
				allocation: objectDefinition.instruction,
				mode: "activation-local",
				slotCount: 1,
				accesses: [{ instruction: loadDefinition.instruction, slot: 0 }],
				materializations: [],
			},
		]);
		expect(analyses.get(CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS, request)).toBe(
			firstProofs,
		);
		const oneDefinition = inspectCoreValueDefinition(fn, one!);
		if (oneDefinition.kind !== "instruction") {
			throw new Error("Expected numeric literal result");
		}
		const editor = CoreEditor.open(core, finished.function);
		editor.replaceInstruction(oneDefinition.instruction, "createNumber", [], {
			attributes: { value: 2 },
		});
		editor.commit();
		const recomputedProofs = analyses.get(
			CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
			request,
		);
		expect(recomputedProofs).not.toBe(firstProofs);
		expect(recomputedProofs.proofs).toEqual(firstProofs.proofs);
		expect(
			report
				.finish(core, { directEntries: [], specializations: [] })
				.analyses.find(({ analysis }) => analysis === "local-stack-object-proofs"),
		).toMatchObject({ queries: 3, hits: 1, recomputations: 2, invalidations: 1 });

		const optimized = optimizeCore({ program: core, context });
		const opcodes = [
			...optimized.compilation.program.function(finished.function).instructionIds(),
		]
			.filter(
				(instruction) =>
					optimized.compilation.program
						.function(finished.function)
						.instructionKind(instruction) === "operation",
			)
			.map((instruction) =>
				optimized.compilation.program
					.function(finished.function)
					.instructionOpcodeName(instruction),
			);
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).not.toContain("createObjectShaped");
	});

	it("retains the boxing move when forwarding an unboxed slot value to global storage", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const input = builder.blockParameterValue(entry, 0);
		const [one] = builder.appendInstruction(entry, "unary", [input], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [loaded!], {
			attributes: { index: 0 },
			outputCount: 0,
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);

		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		const move = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "move",
		);
		expect(move).toBeDefined();
		expect(fn.valueRepresentation(inspectCoreInstructionResults(fn, move!)[0]!)).toBe(
			"boxed",
		);
		expect(fn.valueRepresentation(inspectCoreInstructionOperands(fn, move!)[0]!)).toBe(
			"f64",
		);
	});

	it("does not solve value kinds for a stack object requiring materialization", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7.5 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
			attributes: { keyStringIndices: [0] },
		});
		builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: object! });
		const id = builder.finish(entry).function;
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, lockedContext, report);
		const pass = CORE_MEMORY_PASSES.find(
			({ name }) => name === "refine-stack-object-cell-representations",
		)!;
		new CoreFunctionPassScheduler(core, lockedContext, analyses, report, id).runComponent(
			"memory",
			[pass],
		);
		const result = report.finish(core, { directEntries: [], specializations: [] });
		expect(result.passes.find(({ pass: name }) => name === pass.name)?.runs).toBe(1);
		expect(
			result.analyses.find(({ analysis }) => analysis === "local-value-kinds"),
		).toBeUndefined();
		expect(core.function(id).valueRepresentation(value!)).toBe("boxed");
	});

	it.each(["binary", "unary"] as const)(
		"preserves the numeric input contract when refining a %s stack cell",
		(opcode) => {
			for (const representation of ["boxed", "f64"] as const) {
				const core = program();
				const builder = new CoreFunctionBuilder(core);
				const entry = builder.createBlock();
				const [input] = builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value: 7.5 },
					outputRepresentations: [representation],
				});
				const [divisor] = builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value: 2 },
					outputRepresentations: ["f64"],
				});
				const [value] = builder.appendInstruction(
					entry,
					opcode,
					opcode === "binary" ? [input!, divisor!] : [input!],
					{ attributes: { operator: opcode === "binary" ? "/" : "-" } },
				);
				const [object] = builder.appendInstruction(
					entry,
					"createObjectShaped",
					[value!],
					{
						attributes: { keyStringIndices: [0] },
					},
				);
				const [loaded] = builder.appendInstruction(
					entry,
					"loadPropertyStatic",
					[object!],
					{
						attributes: { stringIndex: 0 },
					},
				);
				builder.setTerminator(entry, { kind: "return", value: loaded! });
				const finished = builder.finish(entry);
				const report = new CoreOptimizationReportBuilder(core);
				const analyses = new CoreAnalysisManager(core, lockedContext, report);
				const pass = CORE_MEMORY_PASSES.find(
					({ name }) => name === "refine-stack-object-cell-representations",
				)!;
				new CoreFunctionPassScheduler(
					core,
					lockedContext,
					analyses,
					report,
					finished.function,
					{
						verification: "per-pass",
					},
				).runComponent("memory", [pass]);
				const fn = core.function(finished.function);
				expect(fn.valueRepresentation(input!)).toBe(representation);
				expect(fn.valueRepresentation(value!)).toBe(representation);
				expect(fn.valueRepresentation(loaded!)).toBe(representation);
			}
		},
	);

	it("unboxes a numeric join after eliminating its object slot", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [one] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [half] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 0.5 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [one!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [half!] },
		});
		const value = builder.appendBlockParameter(merge);
		const [object] = builder.appendInstruction(merge, "createObjectShaped", [value], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(merge, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(merge, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);

		const optimized = optimizeCore({ program: core, context });
		const fn = optimized.compilation.program.function(finished.function);
		const returned = inspectCoreTerminatorPayload(fn, fn.blockTerminator(merge));
		expect(returned.kind).toBe("return");
		if (returned.kind !== "return") throw new Error("Expected return terminator");
		expect(fn.valueRepresentation(value)).toBe("f64");
		expect(fn.valueRepresentation(returned.value)).toBe("f64");
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			expect(["createObjectShaped", "loadPropertyStatic"]).not.toContain(
				fn.instructionOpcodeName(instruction),
			);
		}
	});

	it("carries conflicting branch slot values through scalar replacement", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
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
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					["createObjectShaped", "loadPropertyStatic", "storePropertyStatic"].includes(
						fn.instructionOpcodeName(instruction),
					),
			),
		).toHaveLength(0);
		const incomingCounts = new Map<number, number>();
		for (const block of fn.blockIds()) {
			for (const edge of coreTerminatorEdges(
				inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)),
			)) {
				incomingCounts.set(edge.block, (incomingCounts.get(edge.block) ?? 0) + 1);
			}
		}
		const finalMerge = [...fn.blockIds()].find(
			(block) =>
				incomingCounts.get(block) === 2 &&
				inspectCoreBlockParameters(fn, block).length === 1,
		)!;
		const merged = inspectCoreBlockParameters(fn, finalMerge)[0]!.value;
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(finalMerge))).toEqual({
			kind: "return",
			value: merged,
		});
		const incoming = [...fn.blockIds()].flatMap((block) =>
			coreTerminatorEdges(inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)))
				.filter((edge) => edge.block === finalMerge)
				.map((edge) => edge.arguments[0]),
		);
		const finalConstants = [...fn.instructionIds()]
			.filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "createNumber" &&
					(fn.instructionAttributes(instruction).value === 1 ||
						fn.instructionAttributes(instruction).value === 2),
			)
			.map((instruction) => inspectCoreInstructionResults(fn, instruction)[0]!);
		expect(new Set(incoming)).toEqual(new Set(finalConstants));
	});

	it("flattens forwarding chains before deleting their intermediate loads", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
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
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadPropertyStatic",
			),
		).toHaveLength(0);
	});

	it("widens an out-of-layout alias to family memory and marks the object escaped", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [key] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadProperty", [object!, key!]);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const definition = inspectCoreValueDefinition(fn, loaded!);
		if (definition.kind !== "instruction") throw new Error("Expected load result");
		const provenance = analyzeCoreProvenance(core, finished.function);
		expect(provenance.escape(provenance.layouts[0]!.instruction)).toBe("escaped");
		expect(
			coreMemoryAccesses(fn, definition.instruction, {
				ownCell(base, accessKey, mode) {
					const resolved = provenance.ownCell(base, accessKey, mode);
					return resolved === undefined
						? undefined
						: { allocation: resolved.layout.instruction, cell: resolved.cell };
				},
			})[0]!.location,
		).toEqual({ kind: "family", family: "object-slot" });
	});

	it("keeps weakly holdable values rooted by an otherwise removable aggregate", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const held = inspectCoreBlockParameters(builder, entry)[0]!.value;
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
		expect(
			[...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "createObjectShaped",
			),
		).toBe(true);
	});

	it.each([
		["Symbol.prototype", "description", "get"],
		["Math", "abs", "value"],
		["globalThis", "Number", "value"],
	])(
		"removes private descriptors of rooted %s.%s identities across loop handlers",
		(owner, key, field) => {
			const source = (escape: boolean) => `function probe(consume, count) {
			let result = 0;
			for (let i = 0; i < count; i++) {
				try {
					const descriptor = Object.getOwnPropertyDescriptor(${owner}, '${key}');
					result += consume(${escape ? "descriptor" : `descriptor.${field}`});
				} catch (error) { result--; }
			}
			return result;
		} globalThis.probe = probe;`;
			const contained = inspectStaticValueFunction(source(false), "probe");
			expect(contained.structure.allocations).toBe(0);
			expect(contained.structure.genericCalls).toBe(1);
			const escaped = inspectStaticValueFunction(source(true), "probe");
			expect(escaped.structure.allocations).toBe(1);
			expect(escaped.structure.genericCalls).toBe(1);
		},
	);

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
		const [has] = builder.appendInstruction(entry, "callKnown", [map!, key!], {
			attributes: {
				operation: "Map.prototype.has",
				specialized: "Map.prototype.has",
				worldAssumptions: {
					...builtinWorldAssumptions("Map.prototype.has", "exact-builtin-proof"),
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: has! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program: core, context: lockedContext });
		const fn = optimized.compilation.program.function(finished.function);
		const call = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "callKnown" &&
				fn.instructionAttributes(instruction).operation === "Map.prototype.has",
		);
		expect(call).toBeDefined();
		expect(fn.instructionAttributes(call!).exactCollectionReceiver).toBe("Map");
		const refinement = fn.instructionEffectRefinement(call!);
		expect(refinement).toBeDefined();
		expect(fn.fact(refinement!.proof).kind).toBe("exact-collection-builtin-effects");
	});

	it("publishes an exact numeric TypedArray brand on local dynamic accesses", () => {
		const build = (compilationContext: CoreCompilationContext) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core);
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const key = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const [constructor] = builder.appendInstruction(entry, "loadIntrinsic", [], {
				attributes: { intrinsic: "Uint32Array" },
			});
			const [length] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 4 },
			});
			const [array] = builder.appendInstruction(entry, "construct", [
				constructor!,
				length!,
			]);
			builder.appendInstruction(entry, "storeProperty", [array!, key, length!]);
			const [loaded] = builder.appendInstruction(entry, "loadProperty", [array!, key]);
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const finished = builder.finish(entry);
			const fn = optimizeCore({
				program: core,
				context: compilationContext,
			}).compilation.program.function(finished.function);
			const accesses = [...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					(fn.instructionOpcodeName(instruction) === "loadProperty" ||
						fn.instructionOpcodeName(instruction) === "storeProperty"),
			);
			expect(accesses).toHaveLength(2);
			return accesses.map(
				(instruction) => fn.instructionAttributes(instruction).exactTypedArrayKind,
			);
		};

		expect(build(lockedContext)).toEqual(["Uint32Array", "Uint32Array"]);
		expect(build(context)).toEqual([undefined, undefined]);
	});

	it("publishes contained fixed storage only for unexposed literal-length TypedArrays", () => {
		const build = (mode: "contained" | "external-buffer" | "exposed") => {
			const core = new CoreProgram(coreOpcodeRegistry, {
				stringConstants: [
					[0x78],
					[0x79],
					[0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68],
					[0x62, 0x75, 0x66, 0x66, 0x65, 0x72],
				],
			});
			const builder = new CoreFunctionBuilder(core);
			const entry = builder.createBlock(
				mode === "external-buffer" ? [{ representation: "boxed" }] : [],
			);
			const [constructor] = builder.appendInstruction(entry, "loadIntrinsic", [], {
				attributes: { intrinsic: "Uint16Array" },
			});
			const [index] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 0 },
				outputRepresentations: ["i32"],
			});
			const argument =
				mode === "external-buffer"
					? inspectCoreBlockParameters(builder, entry)[0]!.value
					: index!;
			const [array] = builder.appendInstruction(entry, "construct", [
				constructor!,
				argument,
			]);
			builder.appendInstruction(entry, "storeProperty", [array!, index!, index!]);
			const [loaded] = builder.appendInstruction(entry, "loadProperty", [array!, index!]);
			const [length] = builder.appendInstruction(entry, "loadPropertyStatic", [array!], {
				attributes: { stringIndex: 2 },
			});
			if (mode === "exposed") {
				builder.appendInstruction(entry, "loadPropertyStatic", [array!], {
					attributes: { stringIndex: 3 },
				});
			}
			const [result] = builder.appendInstruction(entry, "binary", [loaded!, length!], {
				attributes: { operator: "+" },
			});
			builder.setTerminator(entry, { kind: "return", value: result! });
			const finished = builder.finish(entry);
			const fn = optimizeCore({
				program: core,
				context: lockedContext,
			}).compilation.program.function(finished.function);
			return [...fn.instructionIds()]
				.filter((instruction) => {
					if (fn.instructionKind(instruction) !== "operation") return false;
					const opcode = fn.instructionOpcodeName(instruction);
					return (
						opcode === "loadProperty" ||
						opcode === "storeProperty" ||
						(opcode === "loadPropertyStatic" &&
							fn.instructionAttributes(instruction).stringIndex === 2)
					);
				})
				.map((instruction) => fn.instructionAttributes(instruction));
		};

		const contained = build("contained");
		expect(contained).toHaveLength(3);
		expect(contained[0]!.containedFixedTypedArrayKind).toBe("Uint16Array");
		expect(contained[1]!.containedFixedTypedArrayKind).toBe("Uint16Array");
		expect(contained[2]!.containedFixedTypedArrayLength).toBe(true);

		const external = build("external-buffer");
		expect(external).toHaveLength(3);
		expect(external[0]!.exactTypedArrayKind).toBe("Uint16Array");
		expect(external[1]!.exactTypedArrayKind).toBe("Uint16Array");
		expect(
			external.every(
				(attributes) => attributes.containedFixedTypedArrayKind === undefined,
			),
		).toBe(true);
		expect(external[2]!.containedFixedTypedArrayLength).toBeUndefined();

		const exposed = build("exposed");
		expect(exposed).toHaveLength(3);
		expect(exposed[0]!.containedFixedTypedArrayKind).toBeUndefined();
		expect(exposed[1]!.containedFixedTypedArrayKind).toBeUndefined();
		expect(exposed[2]!.containedFixedTypedArrayLength).toBeUndefined();
	});

	it("publishes Map.set and Map.get consequences before cleanup", () => {
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
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 42 },
		});
		builder.appendInstruction(entry, "callKnown", [map!, key!, value!], {
			attributes: {
				operation: "Map.prototype.set",
				specialized: "Map.prototype.set",
				worldAssumptions: {
					...builtinWorldAssumptions("Map.prototype.set", "exact-builtin-proof"),
				},
			},
		});
		const [loaded] = builder.appendInstruction(entry, "callKnown", [map!, key!], {
			attributes: {
				operation: "Map.prototype.get",
				specialized: "Map.prototype.get",
				worldAssumptions: {
					...builtinWorldAssumptions("Map.prototype.get", "exact-builtin-proof"),
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);

		const fn = optimizeCore({
			program: core,
			context: lockedContext,
		}).compilation.program.function(finished.function);
		const calls = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "callKnown",
		);
		expect(calls).toHaveLength(2);
		const callNamed = (operation: string) =>
			calls.find(
				(instruction) => fn.instructionAttributes(instruction).operation === operation,
			)!;
		const set = callNamed("Map.prototype.set");
		const get = callNamed("Map.prototype.get");
		for (const call of [set, get]) {
			expect(fn.instructionAttributes(call).exactCollectionReceiver).toBe("Map");
			const refinement = fn.instructionEffectRefinement(call);
			expect(refinement).toBeDefined();
			expect(fn.fact(refinement!.proof).kind).toBe("exact-collection-builtin-effects");
			expect(refinement!.effects).toMatchObject({
				reads: ["object-property"],
				mayThrow: false,
				maySuspend: false,
				callsUserCode: false,
			});
		}
		expect(fn.instructionEffectRefinement(set)?.effects).toMatchObject({
			writes: ["object-property"],
			mayGc: true,
		});
		expect(fn.instructionEffectRefinement(get)?.effects).toMatchObject({
			writes: [],
			mayGc: false,
		});
	});

	it("invalidates memory facts without invalidating CFG or local call topology", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const fn = core.function(finished.function);
		const definition = inspectCoreValueDefinition(fn, loaded!);
		if (definition.kind !== "instruction") throw new Error("Expected load result");
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, context, report);
		const request = { scope: "function", function: finished.function } as const;
		const control = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
		const cfg = control.ordinary();
		const calls = analyses.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request);
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request);
		const candidates = analyses.get(
			CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
			request,
		);
		const editor = CoreEditor.open(core, finished.function);
		const effects = {
			reads: ["object-property"],
			writes: [],
			mayThrow: false,
			maySuspend: false,
			mayGc: false,
			callsUserCode: false,
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
		expect(analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request)).toBe(control);
		expect(control.ordinary()).toBe(cfg);
		expect(analyses.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request)).toBe(calls);
		expect(analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request)).not.toBe(memory);
		expect(analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, request)).not.toBe(
			candidates,
		);
	});

	it("deduplicates immutable discovery records by stable ID", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [object] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 0 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, one!], {
			attributes: { operator: "+" },
		});
		const [next] = builder.appendInstruction(entry, "binary", [sum!, one!], {
			attributes: { operator: "+" },
		});
		builder.appendInstruction(entry, "rootUse", [object!]);
		builder.setTerminator(entry, { kind: "return", value: next! });
		const finished = builder.finish(entry);
		const discovery = discoverCoreLocalSpecializationCandidates(core, finished.function);
		expect(new Set(discovery.candidates.map(({ key }) => key)).size).toBe(
			discovery.candidates.length,
		);
		expect(Object.isFrozen(discovery.candidates)).toBe(true);
		const dense = discovery.candidates.find(({ kind }) => kind === "dense-array");
		expect(dense?.allocation).toBeTypeOf("number");
		expect(discovery.candidates.some(({ kind }) => kind === "numeric-fusion")).toBe(true);
	});
});
