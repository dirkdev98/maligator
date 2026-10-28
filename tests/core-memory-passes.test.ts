import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
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
	analyzeCoreMemoryVersions,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
} from "../src/compiler/core/core-ir-memory.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
	analyzeCoreProvenance,
	discoverCoreLocalSpecializationCandidates,
} from "../src/compiler/core/core-ir-provenance.ts";
import {
	CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
	CORE_EXACT_OWN_SLOT_ATTRIBUTE,
} from "../src/compiler/core/core-ir-shape-provenance.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-ir-value-kinds.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { CORE_MEMORY_PASSES } from "../src/compiler/core/core-memory-passes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { builtinWorldAssumptions } from "../src/compiler/shared/builtin-assumptions.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_SYMBOL,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { knownOperationCall } from "../src/compiler/shared/known-operations.ts";
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

function forwardMemoryLoads(core: CoreProgram, fn: CoreFunctionStore): void {
	const report = new CoreOptimizationReportBuilder(core);
	const analyses = new CoreAnalysisManager(core, context, report);
	const pass = CORE_MEMORY_PASSES.find(
		({ name }) => name === "forward-exact-memory-loads",
	)!;
	new CoreFunctionPassScheduler(core, context, analyses, report, fn.id, {
		optionalMaxRunsPerWorkItem: 1,
		verification: "per-pass",
	}).runComponent("memory", [pass]);
}

function appendArrayBuiltin(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	receiver: CoreValueId,
	operation: "Array.prototype.push" | "Array.prototype.pop",
	arguments_: ReadonlyArray<CoreValueId> = [],
): CoreValueId {
	return builder.appendInstruction(block, "callKnown", [receiver, ...arguments_], {
		attributes: {
			operation,
			worldAssumptions: { ...builtinWorldAssumptions(operation, "literal-allocation") },
			knownBuiltinCall: knownOperationCall(
				operation,
				builder.functionId,
			) as unknown as CoreAttributeValue,
		},
	})[0]!;
}

function rewriteFreshArrayBuiltins(core: CoreProgram, fn: CoreFunctionStore): void {
	const report = new CoreOptimizationReportBuilder(core);
	const analyses = new CoreAnalysisManager(core, lockedContext, report);
	const pass = CORE_MEMORY_PASSES.find(
		({ name }) => name === "rewrite-contained-fresh-array-builtins",
	)!;
	new CoreFunctionPassScheduler(core, lockedContext, analyses, report, fn.id, {
		optionalMaxRunsPerWorkItem: 1,
		verification: "per-pass",
	}).runComponent("memory", [pass]);
}

describe("Core local memory, provenance, and escape optimization", () => {
	it("refreshes a weak mutator's own effect proof after the key kind changes", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const constructor = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "WeakMap" },
		})[0]!;
		const receiver = builder.appendInstruction(entry, "construct", [constructor])[0]!;
		const key = builder.appendInstruction(entry, "createObject", [])[0]!;
		const keyInstruction = builder.bodyInstructionIds(entry).at(-1)!;
		const value = builder.appendInstruction(entry, "createUndefined", [])[0]!;
		const result = builder.appendInstruction(entry, "callKnown", [receiver, key, value], {
			attributes: {
				operation: "WeakMap.prototype.set",
				worldAssumptions: {
					...builtinWorldAssumptions("WeakMap.prototype.set", "literal-allocation"),
				},
				knownBuiltinCall: knownOperationCall(
					"WeakMap.prototype.set",
					builder.functionId,
				) as unknown as CoreAttributeValue,
			},
		})[0]!;
		const call = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "return", value: result });
		const fn = core.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, lockedContext, report);
		const pass = CORE_MEMORY_PASSES.find(
			({ name }) => name === "refine-exact-collection-accesses",
		)!;
		const refine = () =>
			new CoreFunctionPassScheduler(core, lockedContext, analyses, report, fn.id, {
				optionalMaxRunsPerWorkItem: 1,
				verification: "per-pass",
			}).runComponent("memory", [pass]);
		refine();
		let proof = fn.instructionEffectRefinement(call)!;
		expect(proof.effects).toMatchObject({
			mayThrow: false,
			mayGc: true,
			callsUserCode: false,
		});
		for (const [opcode, mayThrow] of [
			["createUndefined", true],
			["createObject", false],
		] as const) {
			const edit = CoreEditor.open(core, fn.id);
			edit.replaceInstruction(keyInstruction, opcode, []);
			edit.commit();
			refine();
			const next = fn.instructionEffectRefinement(call)!;
			expect(next.effects).toMatchObject({ mayThrow, mayGc: true, callsUserCode: false });
			expect(fn.isFactLive(proof.proof)).toBe(false);
			proof = next;
		}
	});

	it.each(["store-alias", "handler", "mixed-join", "push-argument"] as const)(
		"keeps fresh-array containment separate across candidates: %s",
		(escape) => {
			const core = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
			const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
			const entry = builder.createBlock([{}]);
			const flag = builder.blockParameterValue(entry, 0);
			const [contained] = builder.appendInstruction(entry, "createArray", [], {
				attributes: { length: 0 },
			});
			const [escaped] = builder.appendInstruction(entry, "createArray", [], {
				attributes: { length: 0 },
			});
			const body = escape === "handler" ? builder.createBlock() : entry;
			if (body !== entry)
				builder.setTerminator(entry, {
					kind: "jump",
					edge: { block: body, arguments: [] },
				});
			const localPush = appendArrayBuiltin(
				builder,
				body,
				contained!,
				"Array.prototype.push",
				escape === "push-argument" ? [escaped!] : [flag],
			);
			const escapedPush = appendArrayBuiltin(
				builder,
				body,
				escaped!,
				"Array.prototype.push",
				[flag],
			);
			const localPop = appendArrayBuiltin(
				builder,
				body,
				contained!,
				"Array.prototype.pop",
			);
			if (escape === "store-alias") {
				const [alias] = builder.appendInstruction(entry, "move", [escaped!]);
				builder.appendInstruction(entry, "storeGlobal", [alias!], {
					attributes: { index: 0 },
				});
			}
			if (escape === "handler") {
				const handler = builder.createBlock([{ role: "exception" }, {}]);
				builder.setHandler(body, handler, [escaped!]);
				builder.setTerminator(handler, {
					kind: "return",
					value: builder.blockParameterValue(handler, 1),
				});
			}
			if (escape === "mixed-join") {
				const [other] = builder.appendInstruction(entry, "createArray", [], {
					attributes: { length: 0 },
				});
				const merge = builder.createBlock([{}]);
				builder.setTerminator(entry, {
					kind: "branch",
					condition: flag,
					consequent: { block: merge, arguments: [escaped!] },
					alternate: { block: merge, arguments: [other!] },
				});
				builder.setTerminator(merge, {
					kind: "return",
					value: builder.blockParameterValue(merge, 0),
				});
			} else builder.setTerminator(body, { kind: "return", value: localPop });
			const fn = core.function(builder.finish(entry).function);
			rewriteFreshArrayBuiltins(core, fn);
			for (const [value, operation] of [
				[localPush, "Array.prototype.push"],
				[localPop, "Array.prototype.pop"],
				[escapedPush, undefined],
			] as const) {
				const definition = inspectCoreValueDefinition(fn, value);
				if (definition.kind !== "instruction") throw new Error("Expected array call");
				expect(fn.instructionAttributes(definition.instruction).specialized).toBe(
					operation,
				);
			}
		},
	);

	it.each(["before", "after"] as const)(
		"checks return-wrapper publication against each array's last call: %s",
		(publication) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core);
			const entry = builder.createBlock();
			const [first] = builder.appendInstruction(entry, "createArray", [], {
				attributes: { length: 0 },
			});
			const [second] = builder.appendInstruction(entry, "createArray", [], {
				attributes: { length: 0 },
			});
			const firstPush = appendArrayBuiltin(
				builder,
				entry,
				first!,
				"Array.prototype.push",
			);
			const wrap = () =>
				builder.appendInstruction(entry, "createObjectShaped", [first!, second!], {
					attributes: { keyStringIndices: [0, 1] },
				})[0]!;
			let wrapper = publication === "before" ? wrap() : undefined;
			const secondPush = appendArrayBuiltin(
				builder,
				entry,
				second!,
				"Array.prototype.push",
			);
			wrapper ??= wrap();
			builder.setTerminator(entry, { kind: "return", value: wrapper });
			const fn = core.function(builder.finish(entry).function);
			rewriteFreshArrayBuiltins(core, fn);
			for (const [value, specializes] of [
				[firstPush, true],
				[secondPush, publication === "after"],
			] as const) {
				const definition = inspectCoreValueDefinition(fn, value);
				if (definition.kind !== "instruction") throw new Error("Expected array call");
				expect(fn.instructionAttributes(definition.instruction).specialized).toBe(
					specializes ? "Array.prototype.push" : undefined,
				);
			}
		},
	);

	it.each([false, true])(
		"bounds non-observable probe reuse at collection: %s",
		(collects) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
			const entry = builder.createBlock([{}]);
			const receiver = builder.blockParameterValue(entry, 0);
			const [key] = builder.appendInstruction(entry, "createUndefined", []);
			const [first, firstSuccess] = builder.appendInstruction(
				entry,
				"probeRead",
				[receiver, key!],
				{ attributes: { readKind: "named", stringIndex: 0 }, outputCount: 2 },
			);
			if (collects)
				builder.appendInstruction(entry, "createArray", [], { attributes: { count: 0 } });
			const [second, secondSuccess] = builder.appendInstruction(
				entry,
				"probeRead",
				[receiver, key!],
				{ attributes: { readKind: "named", stringIndex: 0 }, outputCount: 2 },
			);
			const [same] = builder.appendInstruction(entry, "binary", [first!, second!], {
				attributes: { operator: "===" },
			});
			const [sameSuccess] = builder.appendInstruction(
				entry,
				"binary",
				[firstSuccess!, secondSuccess!],
				{ attributes: { operator: "===" } },
			);
			const [result] = builder.appendInstruction(entry, "binary", [same!, sameSuccess!], {
				attributes: { operator: "===" },
			});
			builder.setTerminator(entry, { kind: "return", value: result! });
			const fn = core.function(builder.finish(entry).function);
			forwardMemoryLoads(core, fn);
			expect(
				[...fn.bodyInstructionIds(entry)].filter(
					(instruction) => fn.instructionOpcodeName(instruction) === "probeRead",
				),
			).toHaveLength(collects ? 2 : 1);
		},
	);

	it("shares the private backing reference after ordinary class lowering", () => {
		const result = inspectStaticValueFunction(
			`class PrivateReference {
				#columns = [];
				static same(receiver) {
					const first = receiver.#columns;
					const second = receiver.#columns;
					const third = receiver.#columns;
					return first === second && second === third;
				}
			}
			globalThis.probe = PrivateReference.same;`,
			"same",
		);
		expect(
			result.core.filter((instruction) => instruction.opcode === "loadPrivate"),
		).toHaveLength(1);
	});

	it.each(["same block", "ordinary successor"])(
		"retains each block's first private brand check: %s",
		(flow) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 2 });
			const entry = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const receiver = builder.blockParameterValue(entry, 0);
			const key = builder.blockParameterValue(entry, 1);
			const [first] = builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
			const firstInstruction = builder.bodyInstructionIds(entry).at(-1)!;
			const body = flow === "same block" ? entry : builder.createBlock();
			if (body !== entry)
				builder.setTerminator(entry, {
					kind: "jump",
					edge: { block: body, arguments: [] },
				});
			const [second] = builder.appendInstruction(body, "loadPrivate", [receiver, key]);
			const secondInstruction = builder.bodyInstructionIds(body).at(-1)!;
			const [last] = builder.appendInstruction(body, "loadPrivate", [receiver, key]);
			builder.setTerminator(body, { kind: "return", value: last! });
			const fn = core.function(builder.finish(entry).function);
			forwardMemoryLoads(core, fn);
			expect(
				[...fn.instructionIds()].filter(
					(instruction) =>
						fn.instructionKind(instruction) === "operation" &&
						fn.instructionOpcodeName(instruction) === "loadPrivate",
				),
			).toEqual(
				body === entry ? [firstInstruction] : [firstInstruction, secondInstruction],
			);
			expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(body))).toEqual({
				kind: "return",
				value: body === entry ? first : second,
			});
			expect(fn.instructionEffectRefinement(firstInstruction)).toBeUndefined();
		},
	);

	it("keeps independent private reads before, within, and after a loop", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const receiver = builder.blockParameterValue(entry, 0);
		const key = builder.blockParameterValue(entry, 1);
		const repeat = builder.blockParameterValue(entry, 2);
		const [before] = builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
		const entryRead = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [] },
		});
		builder.appendInstruction(body, "loadPrivate", [receiver, key]);
		const bodyRead = builder.bodyInstructionIds(body).at(-1)!;
		const [during] = builder.appendInstruction(body, "loadPrivate", [receiver, key]);
		builder.setTerminator(body, {
			kind: "branch",
			condition: repeat,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [after] = builder.appendInstruction(exit, "loadPrivate", [receiver, key]);
		const exitRead = builder.bodyInstructionIds(exit).at(-1)!;
		const [last] = builder.appendInstruction(exit, "loadPrivate", [receiver, key]);
		builder.appendInstruction(exit, "rootUse", [before!, during!, last!]);
		builder.setTerminator(exit, { kind: "return", value: last! });
		const fn = core.function(builder.finish(entry).function);
		forwardMemoryLoads(core, fn);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadPrivate",
			),
		).toEqual([entryRead, bodyRead, exitRead]);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(exit))).toEqual({
			kind: "return",
			value: after,
		});
	});

	it.each(["allocation", "known read-only call"])(
		"restarts private reuse after a collecting %s even when memory versions agree",
		(barrier) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 3 });
			const entry = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const receiver = builder.blockParameterValue(entry, 0);
			const key = builder.blockParameterValue(entry, 1);
			const collection = builder.blockParameterValue(entry, 2);
			const [first] = builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
			const firstRead = builder.bodyInstructionIds(entry).at(-1)!;
			const [intermediate] =
				barrier === "allocation"
					? builder.appendInstruction(entry, "createArray", [], {
							attributes: { length: 0 },
						})
					: builder.appendInstruction(entry, "callKnown", [collection, key], {
							attributes: {
								operation: "Map.prototype.get",
								worldAssumptions: {
									...builtinWorldAssumptions("Map.prototype.get", "exact-builtin-proof"),
								},
							},
						});
			const collecting = builder.bodyInstructionIds(entry).at(-1)!;
			const [second] = builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
			const secondRead = builder.bodyInstructionIds(entry).at(-1)!;
			const [last] = builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
			builder.appendInstruction(entry, "rootUse", [first!, intermediate!, last!]);
			builder.setTerminator(entry, { kind: "return", value: last! });
			const fn = core.function(builder.finish(entry).function);
			if (barrier === "known read-only call") {
				const editor = CoreEditor.open(core, fn.id);
				const effects = {
					...CORE_NO_EFFECTS,
					reads: ["object-property"],
					mayGc: true,
					mayThrow: true,
				} as const;
				const proof = editor.addFact({
					kind: "test-read-only-call",
					value: true,
					claims: [{ kind: "effect", instruction: collecting, effects }],
					validity: { kind: "summary", digest: "test-read-only-call" },
					obligations: [],
					origin: "test",
				});
				editor.setInstructionEffectRefinement(collecting, { effects, proof });
				editor.commit();
			}
			expect(
				analyzeCoreMemoryVersions(core, fn.id).readsEquivalent(firstRead, secondRead),
			).toBe(true);
			forwardMemoryLoads(core, fn);
			expect(
				[...fn.instructionIds()].filter(
					(instruction) =>
						fn.instructionKind(instruction) === "operation" &&
						fn.instructionOpcodeName(instruction) === "loadPrivate",
				),
			).toEqual([firstRead, secondRead]);
			expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
				kind: "return",
				value: second,
			});
		},
	);

	it.each([
		"private store",
		"unknown call",
		"ordinary getter",
		"other receiver",
		"other private name",
	])("retains a private load after %s", (change) => {
		const core = program();
		const builder = new CoreFunctionBuilder(core, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const receiver = builder.blockParameterValue(entry, 0);
		const key = builder.blockParameterValue(entry, 1);
		const other = builder.blockParameterValue(entry, 2);
		builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
		if (change === "private store")
			builder.appendInstruction(entry, "storePrivate", [receiver, key, other]);
		else if (change === "unknown call")
			builder.appendInstruction(entry, "call", [other, receiver]);
		else if (change === "ordinary getter")
			builder.appendInstruction(entry, "loadPropertyStatic", [receiver], {
				attributes: { stringIndex: 0 },
			});
		const [last] = builder.appendInstruction(entry, "loadPrivate", [
			change === "other receiver" ? other : receiver,
			change === "other private name" ? other : key,
		]);
		builder.setTerminator(entry, { kind: "return", value: last! });
		const fn = core.function(builder.finish(entry).function);
		forwardMemoryLoads(core, fn);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadPrivate",
			),
		).toHaveLength(2);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "return",
			value: last,
		});
	});

	it("does not reuse a private load reached again after its first attempt threw", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const handler = builder.createBlock([{ representation: "boxed", role: "exception" }]);
		const retry = builder.createBlock();
		const receiver = builder.blockParameterValue(entry, 0);
		const key = builder.blockParameterValue(entry, 1);
		const callback = builder.blockParameterValue(entry, 2);
		builder.setHandler(entry, handler, []);
		builder.appendInstruction(entry, "loadPrivate", [receiver, key]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: retry, arguments: [] },
		});
		builder.appendInstruction(handler, "call", [callback, receiver]);
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: retry, arguments: [] },
		});
		const [last] = builder.appendInstruction(retry, "loadPrivate", [receiver, key]);
		builder.setTerminator(retry, { kind: "return", value: last! });
		const fn = core.function(builder.finish(entry).function);
		forwardMemoryLoads(core, fn);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadPrivate",
			),
		).toHaveLength(2);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(retry))).toEqual({
			kind: "return",
			value: last,
		});
	});

	it.each(["changed key order", "materialized object"] as const)(
		"refreshes an existing own-slot cache hint after %s",
		(change) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [object] = builder.appendInstruction(
				entry,
				"createObjectShaped",
				[value!, value!],
				{
					attributes: { keyStringIndices: [0, 1] },
				},
			);
			const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const fn = core.function(builder.finish(entry).function);
			const allocation = inspectCoreValueDefinition(fn, object!),
				load = inspectCoreValueDefinition(fn, loaded!);
			if (allocation.kind !== "instruction" || load.kind !== "instruction")
				throw new Error("Expected operation results");
			const report = new CoreOptimizationReportBuilder(core),
				analyses = new CoreAnalysisManager(core, context, report);
			const annotate = CORE_MEMORY_PASSES.find(
				({ name }) => name === "annotate-known-own-slots",
			)!;
			const refresh = () =>
				new CoreFunctionPassScheduler(
					core,
					context,
					analyses,
					report,
					fn.id,
				).runComponent("memory", [annotate]);
			refresh();
			expect(fn.instructionAttributes(load.instruction).knownOwnSlot).toMatchObject({
				candidates: [
					{
						shapeFunctionIndex: fn.id,
						shapeInstruction: allocation.instruction,
						slot: 0,
					},
				],
			});
			const editor = CoreEditor.open(core, fn.id);
			if (change === "changed key order")
				editor.replaceInstruction(
					allocation.instruction,
					"createObjectShaped",
					[value!, value!],
					{
						attributes: { keyStringIndices: [1, 0] },
					},
				);
			else
				editor.replaceInstruction(allocation.instruction, "createObject", [], {
					attributes: { virtualStateMaterialized: true },
				});
			editor.commit();
			refresh();
			if (change === "changed key order")
				expect(fn.instructionAttributes(load.instruction).knownOwnSlot).toMatchObject({
					candidates: [
						{
							shapeFunctionIndex: fn.id,
							shapeInstruction: allocation.instruction,
							slot: 1,
						},
					],
				});
			else
				expect(fn.instructionAttributes(load.instruction).knownOwnSlot).toBeUndefined();
			const versions = fn.versions;
			refresh();
			expect(fn.versions).toEqual(versions);
		},
	);

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
		expect(memory.statistics.indexedInstructions).toBe(0);
		expect(memory.statistics.solvedPartitions).toBe(0);
		const scanned = memory.statistics.localReadInstructions;
		expect(memory.valueForRead(read, { kind: "global-slot", slot: 0 })).toBe(stored);
		expect(memory.statistics.localReadInstructions).toBe(scanned);
		expect(memory.statistics.heapAccessesResolved).toBe(0);
		const result = report.finish(core, { directEntries: [], specializations: [] });
		expect(result.analyses.some(({ analysis }) => analysis === "local-fact-bundle")).toBe(
			false,
		);
		expect(result.counters.provenanceEscapeChecks).toBe(0);
		expect(result.counters.memoryLocalReadAnswers).toBe(1);
		expect(result.counters.memoryLocalReadInstructions).toBe(scanned);
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
		["shaped", "array", "Boolean", "Number", "String", "Object", "new Object"].flatMap(
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
					: allocation === "array"
						? builder.appendInstruction(entry, "createArray", [], {
								attributes: { length: 1 },
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
			if (allocation === "array")
				builder.appendInstruction(entry, "defineProperty", [object!, seven!, payload], {
					attributes: { enumerable: true },
				});
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
					((allocation === "shaped" || allocation === "array") &&
						["mutable", "realm", "new-target", "weak-extra"].includes(scenario))
					? used
					: entry,
			);
			for (const instruction of fn.instructionIds())
				if (
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "defineProperty"
				)
					expect(fn.instructionBlock(instruction)).toBe(
						fn.instructionBlock(definition.instruction),
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
	it.each([
		["function*", "yield 0;"],
		["async function", "await hook();"],
		["async function*", "yield 0;await hook();"],
	])(
		"materializes private returned fields after %s suspension",
		(declaration, suspend) => {
			const out = inspectStaticValueFunction(
				`${declaration} compute(value,hook){const record={n:value};${suspend}record.n=value&255;hook();return record;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.core.some(({ opcode }) => opcode === "storePropertyStatic")).toBe(false);
			expect(out.core.some(({ opcode }) => opcode === "createObjectShaped")).toBe(true);
		},
	);
	it.each(["0", "-0", "0x80000000", "Infinity", "NaN"])(
		"joins integer and floating virtual field writers with initial %s",
		(initial) => {
			const out = inspectStaticValueFunction(
				`function compute(steps,hook){const point={n:${initial}};for(let i=0;i<steps;i++){point.n=-i;}hook();return point.n;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.core.some(({ opcode }) => opcode === "storePropertyStatic")).toBe(false);
			expect(out.core.some(({ opcode }) => opcode === "loadPropertyStatic")).toBe(false);
		},
	);
	it("scalarizes mixed numeric field writers after a loop helper is inlined", () => {
		const image = compileEntrypoint(
			new URL("./local/own-slot-call-effects.js", import.meta.url).pathname,
			{
				buildConfig: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: false },
				}),
				coreVerification: "per-pass",
			},
		);
		const fn = image.native.functions.find(
			(candidate) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[candidate.body.nameStringIndex] ?? []),
				) === "primitiveUntouched",
		)!;
		expect(fn).toBeDefined();
		expect(
			fn.body.instructions.some((instruction) =>
				instruction.opcode.startsWith("LOAD_PROPERTY"),
			),
		).toBe(false);
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

	it("preserves an existing effect proof when annotating an own-slot hint", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const value = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		})[0]!;
		const object = builder.appendInstruction(entry, "createObjectShaped", [value], {
			attributes: { keyStringIndices: [0] },
		})[0]!;
		const loaded = builder.appendInstruction(entry, "loadPropertyStatic", [object], {
			attributes: { stringIndex: 0 },
		})[0]!;
		const load = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "return", value: loaded });
		const fn = core.function(builder.finish(entry).function);
		const editor = CoreEditor.open(core, fn.id);
		const proof = editor.addFact({
			kind: "own-slot-test",
			value: true,
			claims: [{ kind: "effect", instruction: load, effects: CORE_NO_EFFECTS }],
			validity: { kind: "summary", digest: "own-slot-test" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(load, { proof, effects: CORE_NO_EFFECTS });
		editor.commit();
		const report = new CoreOptimizationReportBuilder(core);
		const analyses = new CoreAnalysisManager(core, context, report);
		const pass = CORE_MEMORY_PASSES.find(
			({ name }) => name === "annotate-known-own-slots",
		)!;
		const before = fn.versions;
		const operands = fn.kernel.instructionOperandStart(load);
		const request = { scope: "function", function: fn.id } as const;
		const control = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
		const cfg = control.exceptional();
		const memory = analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request);
		const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
		const proofs = analyses.get(CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS, request);
		const candidates = analyses.get(
			CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
			request,
		);
		const changes = new CoreFunctionPassScheduler(
			core,
			context,
			analyses,
			report,
			fn.id,
		).runComponent("memory", [pass]);
		expect(changes).toHaveLength(1);
		expect(changes[0]!.domains).toEqual(["specializationInputs"]);
		expect(changes[0]!.facts).toEqual([]);
		expect(fn.versions).toEqual({
			...before,
			specializationInputs: before.specializationInputs + 1,
		});
		expect(fn.kernel.instructionOperandStart(load)).toBe(operands);
		expect(analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request)).toBe(control);
		expect(control.exceptional()).toBe(cfg);
		expect(analyses.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request)).toBe(memory);
		expect(analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request)).toBe(kinds);
		expect(analyses.get(CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS, request)).toBe(proofs);
		expect(analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, request)).not.toBe(
			candidates,
		);
		expect(fn.instructionEffectRefinement(load)?.proof).toBe(proof);
		expect(fn.instructionAttributes(load).knownOwnSlot).toBeDefined();
		const hint = fn.instructionAttributes(load).knownOwnSlot;
		const clear = CoreEditor.open(core, fn.id);
		clear.setKnownOwnSlotHint(load, undefined);
		expect(clear.commit().domains).toEqual(["specializationInputs"]);
		expect(fn.instructionAttributes(load).knownOwnSlot).toBeUndefined();
		const allocation = inspectCoreValueDefinition(fn, object);
		if (allocation.kind !== "instruction") throw new Error("Expected object allocation");
		const input = [
			{ shapeFunctionIndex: fn.id, shapeInstruction: allocation.instruction, slot: 0 },
		];
		const restore = CoreEditor.open(core, fn.id);
		expect(() => restore.setKnownOwnSlotHint(load, [])).toThrow(
			"Invalid own-slot candidates",
		);
		restore.setKnownOwnSlotHint(load, input);
		restore.commit();
		input[0]!.slot = 1;
		expect(fn.instructionAttributes(load).knownOwnSlot).toEqual(hint);
		const same = CoreEditor.open(core, fn.id);
		same.setKnownOwnSlotHint(load, [{ ...input[0]!, slot: 0 }]);
		expect(same.commit().edits).toBe(0);
		expect(fn.instructionEffectRefinement(load)?.proof).toBe(proof);
	});

	it.each(["named", "unknown"] as const)(
		"only requests relevant property proofs for a %s receiver",
		(receiver) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const [one] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [object] = builder.appendInstruction(entry, "createObjectShaped", [one!], {
				attributes: { keyStringIndices: [0] },
			});
			const [loaded] = builder.appendInstruction(
				entry,
				"loadPropertyStatic",
				[receiver === "named" ? object! : builder.blockParameterValue(entry, 0)],
				{ attributes: { stringIndex: 0 } },
			);
			const load = builder.bodyInstructionIds(entry).at(-1)!;
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const fn = core.function(builder.finish(entry).function);
			const report = new CoreOptimizationReportBuilder(core);
			const analyses = new CoreAnalysisManager(core, context, report);
			const request = { scope: "function", function: fn.id } as const;
			const provenance = analyses.get(
				CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
				request,
			).provenance;
			analyses.get(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS, request);
			const before = provenance.statistics.valueQueries;
			const pass = CORE_MEMORY_PASSES.find(
				({ name }) => name === "refine-contained-own-slot-accesses",
			)!;
			new CoreFunctionPassScheduler(core, context, analyses, report, fn.id, {
				optionalMaxRunsPerWorkItem: 1,
			}).runComponent("memory", [pass]);
			expect(provenance.statistics.valueQueries - before).toBe(
				receiver === "named" ? 1 : 2,
			);
			expect(fn.instructionAttributes(load)[CORE_EXACT_OWN_SLOT_ATTRIBUTE]).toBe(
				receiver === "named" ? 0 : undefined,
			);
			if (receiver === "named")
				expect(fn.instructionEffectRefinement(load)?.effects).toMatchObject({
					mayThrow: false,
					callsUserCode: false,
				});
			else expect(fn.instructionEffectRefinement(load)).toBeUndefined();
		},
	);

	it.each([
		[COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED, true],
		[COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNDEFINED, false],
		[COMPILER_VALUE_KIND_SYMBOL | COMPILER_VALUE_KIND_UNDEFINED, false],
	] as const)(
		"refines an own-slot write for normal-result mask %i only when lifetime-safe (%s)",
		(mask, refined) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
			const entry = builder.createBlock([{}]);
			const receiver = builder.appendInstruction(entry, "createUndefined", [])[0]!;
			const value = builder.appendInstruction(entry, "call", [
				builder.blockParameterValue(entry, 0),
				receiver,
			])[0]!;
			const producer = builder.bodyInstructionIds(entry).at(-1)!;
			const object = builder.appendInstruction(entry, "createObjectShaped", [value], {
				attributes: { keyStringIndices: [0] },
			})[0]!;
			builder.appendInstruction(entry, "storePropertyStatic", [object, value], {
				attributes: { stringIndex: 0 },
			});
			const write = builder.bodyInstructionIds(entry).at(-1)!;
			builder.setTerminator(entry, { kind: "return", value });
			const fn = core.function(builder.finish(entry).function);
			const editor = CoreEditor.open(core, fn.id);
			editor.setNormalResultFacts(producer, { mask });
			const initial = editor.commit();
			const report = new CoreOptimizationReportBuilder(core);
			const analyses = new CoreAnalysisManager(core, context, report);
			const pass = CORE_MEMORY_PASSES.find(
				({ name }) => name === "refine-contained-own-slot-accesses",
			)!;
			new CoreFunctionPassScheduler(core, context, analyses, report, fn.id, {
				optionalMaxRunsPerWorkItem: 1,
			}).runComponent("memory", [pass], [initial]);
			expect(fn.instructionEffectRefinement(write) !== undefined).toBe(refined);
			expect(fn.instructionEffectRefinement(producer)).toBeUndefined();
		},
	);

	it.each(["initial", "later"] as const)(
		"retains write effects when a weakly holdable value is stored %s",
		(where) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const held = builder.blockParameterValue(entry, 0);
			const [one] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [object] = builder.appendInstruction(
				entry,
				"createObjectShaped",
				[where === "initial" ? held : one!],
				{ attributes: { keyStringIndices: [0] } },
			);
			builder.appendInstruction(entry, "storePropertyStatic", [object!, one!], {
				attributes: { stringIndex: 0 },
			});
			const firstWrite = builder.bodyInstructionIds(entry).at(-1)!;
			if (where === "later")
				builder.appendInstruction(entry, "storePropertyStatic", [object!, held], {
					attributes: { stringIndex: 0 },
				});
			const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const fn = core.function(builder.finish(entry).function);
			const report = new CoreOptimizationReportBuilder(core);
			const analyses = new CoreAnalysisManager(core, context, report);
			const pass = CORE_MEMORY_PASSES.find(
				({ name }) => name === "refine-contained-own-slot-accesses",
			)!;
			new CoreFunctionPassScheduler(core, context, analyses, report, fn.id, {
				optionalMaxRunsPerWorkItem: 1,
			}).runComponent("memory", [pass]);
			expect(fn.instructionEffectRefinement(firstWrite)).toBeUndefined();
		},
	);

	it("forwards an unboxed slot value directly to its scalar global-store boundary", () => {
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
		const store = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "storeGlobal",
		);
		expect(store).toBeDefined();
		expect(inspectCoreInstructionOperands(fn, store!)[0]).toBe(one);
		expect(fn.valueRepresentation(inspectCoreInstructionOperands(fn, store!)[0]!)).toBe(
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

	it.each([false, true])(
		"cleans unused aggregate joins with primitive occupants=%s",
		(primitive) => {
			const core = program();
			const builder = new CoreFunctionBuilder(core, { parameterCount: 2 });
			const entry = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const flag = builder.blockParameterValue(entry, 0);
			const held = builder.blockParameterValue(entry, 1);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "boxed" }]);
			builder.setTerminator(entry, {
				kind: "branch",
				condition: flag,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			for (const block of [left, right]) {
				const value = primitive
					? builder.appendInstruction(block, "createNumber", [], {
							attributes: { value: 42 },
						})[0]!
					: held;
				const [object] = builder.appendInstruction(block, "createObjectShaped", [value], {
					attributes: { keyStringIndices: [0] },
				});
				builder.setTerminator(block, {
					kind: "jump",
					edge: { block: join, arguments: [object!] },
				});
			}
			const [result] = builder.appendInstruction(join, "createBoolean", [], {
				attributes: { value: false },
			});
			builder.setTerminator(join, { kind: "return", value: result! });
			const finished = builder.finish(entry);
			const optimized = optimizeCore({ program: core, context });
			const fn = optimized.compilation.program.function(finished.function);
			expect(
				[...fn.instructionIds()].filter(
					(instruction) =>
						fn.instructionKind(instruction) === "operation" &&
						fn.instructionOpcodeName(instruction) === "createObjectShaped",
				),
			).toHaveLength(primitive ? 0 : 2);
		},
	);

	it.each([
		["Symbol.prototype", "description", "get"],
		["Math", "abs", "value"],
		["globalThis", "Number", "value"],
	])(
		"removes private descriptors of rooted %s.%s only when allocation failure is unhandled",
		(owner, key, field) => {
			for (const handled of [false, true]) {
				const source = (escape: boolean) => `function probe(consume, count) {
			let result = 0;
			for (let i = 0; i < count; i++) {
				${handled ? "try {" : ""}
					const descriptor = Object.getOwnPropertyDescriptor(${owner}, '${key}');
					result += consume(${escape ? "descriptor" : `descriptor.${field}`});
				${handled ? "} catch (error) { result--; }" : ""}
			}
			return result;
		} globalThis.probe = probe;`;
				const contained = inspectStaticValueFunction(source(false), "probe");
				expect(contained.structure.allocations).toBe(handled ? 1 : 0);
				expect(contained.structure.genericCalls).toBe(1);
				const escaped = inspectStaticValueFunction(source(true), "probe");
				expect(escaped.structure.allocations).toBe(1);
				expect(escaped.structure.genericCalls).toBe(1);
			}
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

	it.each([
		[
			"folds the length of a literal read by index",
			"const xs = [10, 20, 30]; let s = 0; for (let i = 0; i < index; i++) s += xs[i % xs.length]; return s;",
			true,
			0,
		],
		[
			"folds the length of a literal with a hole",
			"const xs = [1, , 3]; let s = 0; for (let i = 0; i < index; i++) s += xs[i % xs.length] ?? 0; return s;",
			true,
			0,
		],
		[
			"keeps the length when a mutable prototype may answer an element read",
			"const xs = [10, 20, 30]; let s = 0; for (let i = 0; i < index; i++) s += xs[i % xs.length]; return s;",
			false,
			1,
		],
		[
			"keeps the length after the literal escapes",
			"const xs = [10, 20, 30]; consume(xs); let s = 0; for (let i = 0; i < index; i++) s += xs[i % xs.length]; return s;",
			true,
			1,
		],
		[
			"keeps the length when a store may extend the literal",
			"const xs = [10, 20, 30]; let s = 0; for (let i = 0; i < index; i++) { xs[i] = i; s += xs.length; } return s;",
			true,
			1,
		],
	] as const)("%s", (_name, body, locked, lengthLoads) => {
		const result = inspectStaticValueFunction(
			`function probe(index, consume) { ${body} } globalThis.probe = probe;`,
			"probe",
			{ locked },
		);
		expect(
			result.core.filter(({ opcode }) => opcode === "loadPropertyStatic"),
		).toHaveLength(lengthLoads);
	});
});
