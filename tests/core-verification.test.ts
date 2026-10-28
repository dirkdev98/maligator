import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { formatCoreFunction } from "../src/compiler/core/core-format.ts";
import {
	CORE_CALL_RESULT_KIND_ATTRIBUTE,
	CORE_RECORD_FIELD_KIND_ATTRIBUTE,
	CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE,
} from "../src/compiler/core/core-internal-attributes.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	verifyCoreChangeSet,
	verifyCoreFunction,
	verifyCoreProgram,
} from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS, coreFactId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { builtinWorldAssumptions } from "../src/compiler/shared/builtin-assumptions.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreInstructionResults,
} from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

describe("primordial reference availability", () => {
	function reference(operation: string, index?: number | string) {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "loadPrimordial", [], {
			attributes: {
				nodeIndex:
					index ??
					getPrimordialCatalog().nodes.findIndex((node) => node[0] === operation),
				worldAssumptions: {
					...builtinWorldAssumptions(operation, "exact-builtin-proof", true),
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: value! });
		builder.finish(entry);
		return program;
	}

	it.each([-1, 0.5, "1"])("rejects a malformed primordial index %s", (index) => {
		expect(() => verifyCoreProgram(reference("Math.round", index))).toThrow(
			/Invalid primordial identity/,
		);
	});

	it.each([
		"Intl.Collator",
		"%MAL_INTRINSIC_INTL_SEGMENT_ITERATOR_PROTOTYPE%.next",
		"%MAL_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE%.next",
	])("requires %s to be installed in the configured world", (operation) => {
		const program = reference(operation);
		for (const enabled of [false, true]) {
			const context = {
				...programAnalysisContext(),
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { regexp: enabled, intl: { enabled } } }),
				),
			};
			const verify = () => verifyCoreProgram(program, undefined, context);
			if (enabled) expect(verify).not.toThrow();
			else expect(verify).toThrow(/Unavailable primordial identity/);
		}
	});

	it("gates internal Intl prototypes on their owning service", () => {
		const context = {
			...programAnalysisContext(),
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: { intl: { enabled: true, features: ["collator"] } },
				}),
			),
		};
		expect(() =>
			verifyCoreProgram(reference("Intl.Collator"), undefined, context),
		).not.toThrow();
		expect(() =>
			verifyCoreProgram(
				reference("%MAL_INTRINSIC_INTL_SEGMENT_ITERATOR_PROTOTYPE%.next"),
				undefined,
				context,
			),
		).toThrow(/Unavailable primordial identity/);
	});
});

describe("record field kind metadata", () => {
	it.each([0, 255, 256, -1, NaN, "number"])(
		"rejects invalid record field mask %s",
		(mask) => {
			const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[110]] });
			const builder = new CoreFunctionBuilder(program);
			const block = builder.createBlock();
			const [value] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [object] = builder.appendInstruction(block, "createObjectShaped", [value!], {
				attributes: { keyStringIndices: [0] },
			});
			const [read] = builder.appendInstruction(block, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0, [CORE_RECORD_FIELD_KIND_ATTRIBUTE]: mask },
			});
			builder.setTerminator(block, { kind: "return", value: read! });
			builder.finish(block);
			expect(() => verifyCoreProgram(program)).toThrow(/Invalid record field kind proof/);
		},
	);

	it.each([
		{ mask: 8, minimum: -0, maximum: 7 },
		{ mask: 8, minimum: 0, maximum: Infinity },
		{ mask: 8, minimum: 0, maximum: 0.5 },
		{ mask: 8, minimum: 2, maximum: 1 },
		{ mask: 16, minimum: 0, maximum: 7 },
		{ mask: undefined, minimum: 0, maximum: 7 },
	])("rejects a malformed normal field range %j", ({ mask, minimum, maximum }) => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[110]] });
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [value] = builder.appendInstruction(block, "createUndefined", []);
		const [read] = builder.appendInstruction(block, "loadPropertyStatic", [value!], {
			attributes: {
				stringIndex: 0,
				...(mask === undefined ? {} : { [CORE_RECORD_FIELD_KIND_ATTRIBUTE]: mask }),
				[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE]: {
					minimum,
					maximum,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				},
			},
		});
		builder.setTerminator(block, { kind: "return", value: read! });
		builder.finish(block);
		expect(() => verifyCoreProgram(program)).toThrow(
			/Invalid normal result integer range proof/,
		);
	});

	it("rejects a record field fact on a non-read instruction", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [value] = builder.appendInstruction(block, "createNumber", [], {
			attributes: { value: 1, [CORE_RECORD_FIELD_KIND_ATTRIBUTE]: 8 },
		});
		builder.setTerminator(block, { kind: "return", value: value! });
		builder.finish(block);
		expect(() => verifyCoreProgram(program)).toThrow(/Invalid record field kind proof/);
	});
});

function validBranchProgram() {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const consequent = builder.createBlock();
	const alternate = builder.createBlock();
	const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: consequent, arguments: [] },
		alternate: { block: alternate, arguments: [] },
	});
	builder.setTerminator(consequent, { kind: "return", value: condition! });
	builder.setTerminator(alternate, { kind: "return", value: condition! });
	const finished = builder.finish(entry);
	return {
		program,
		fn: program.function(finished.function),
		entry,
		consequent,
		alternate,
		condition: condition!,
	};
}

describe("Core verification", () => {
	it.each([
		{ mask: 8, minimum: -0, maximum: 7 },
		{ mask: 8, minimum: 0, maximum: Infinity },
		{ mask: 8, minimum: 0, maximum: 0.5 },
		{ mask: 8, minimum: 2, maximum: 1 },
		{ mask: 16, minimum: 0, maximum: 7 },
		{ mask: undefined, minimum: 0, maximum: 7 },
	])("rejects a malformed normal call range %j", ({ mask, minimum, maximum }) => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, callee!], {
			attributes: {
				...(mask === undefined ? {} : { [CORE_CALL_RESULT_KIND_ATTRIBUTE]: mask }),
				[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE]: {
					minimum,
					maximum,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.finish(entry);
		expect(() => verifyCoreProgram(program)).toThrow(
			/Invalid normal result integer range proof/,
		);
	});

	it.each([0, 255, 256, NaN])(
		"rejects an invalid normal call result bound %s",
		(mask) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [callee] = builder.appendInstruction(entry, "createUndefined", []);
			const [result] = builder.appendInstruction(entry, "call", [callee!, callee!], {
				attributes: { [CORE_CALL_RESULT_KIND_ATTRIBUTE]: mask },
			});
			builder.setTerminator(entry, { kind: "return", value: result! });
			builder.finish(entry);
			expect(() => verifyCoreProgram(program)).toThrow(/Invalid call result kind proof/);
		},
	);

	it("rejects rest forwarding state used as a JavaScript value", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [state] = builder.appendInstruction(entry, "createRestArgumentsState", []);
		builder.setTerminator(entry, { kind: "return", value: state! });
		builder.finish(entry);
		expect(() => verifyCoreProgram(program)).toThrow(/Rest state escapes/);
	});

	it.each([
		["boxed", "string", false],
		["boxed", "f64", false],
		["string", "boxed", true],
		["i32", "f64", true],
		["string", "string", true],
	] as const)(
		"lets a move from %s into %s verify only when it does not unbox: %s",
		(source, destination, accepted) => {
			const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[0x61]] });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(
				entry,
				source === "i32" ? "createNumber" : "createString",
				[],
				{
					attributes: source === "i32" ? { value: 1 } : { stringIndex: 0 },
					outputRepresentations: [source],
				},
			);
			const [moved] = builder.appendInstruction(entry, "move", [value!], {
				outputRepresentations: [destination],
			});
			builder.setTerminator(entry, { kind: "return", value: moved! });
			builder.finish(entry);
			const verify = () => verifyCoreProgram(program);
			if (accepted) expect(verify).not.toThrow();
			else expect(verify).toThrow(`unboxes to ${destination} without a proof`);
		},
	);

	it("verifies repeated uses of value zero after operand replacement and row deletion", () => {
		const { program, fn, entry, condition } = validBranchProgram();
		const editor = CoreEditor.open(program, fn.id);
		const replacement = editor.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: false },
		}).outputs[0]!;
		const operations = Array.from(
			{ length: 16 },
			() =>
				editor.appendInstruction(entry, "binary", [condition, condition], {
					attributes: { operator: "===" },
				}).instruction,
		);
		editor.commit();
		expect(() => verifyCoreProgram(program)).not.toThrow();
		const rewrite = CoreEditor.open(program, fn.id);
		for (const [index, instruction] of operations.entries()) {
			if (index % 2 === 0) rewrite.removeInstruction(instruction);
			else rewrite.replaceOperands(instruction, [replacement, condition]);
		}
		rewrite.commit();
		expect(() => verifyCoreProgram(program)).not.toThrow();
	});

	it("rejects an instruction linked more than once in block order", () => {
		const { program, fn, entry } = validBranchProgram();
		const first = fn.kernel.blockFirstInstruction(entry);
		fn.kernel.instructionNext = () => first;
		expect(() => verifyCoreProgram(program)).toThrow(/appears twice in block order/);
	});

	it("retains exact range diagnostics on the invalid path", () => {
		const { program, fn, entry } = validBranchProgram();
		const instruction = fn.kernel.blockFirstInstruction(entry);
		const originalStart = fn.kernel.instructionOperandStart.bind(fn.kernel);
		const invalidStart = fn.operandCapacity + 1;
		fn.kernel.instructionOperandStart = (candidate) =>
			candidate === instruction ? invalidStart : originalStart(candidate);
		expect(() => verifyCoreProgram(program)).toThrow(
			`instruction @${instruction} operand range ${invalidStart}..${invalidStart} exceeds capacity ${fn.operandCapacity}`,
		);
	});

	it("rejects a cyclic value-use chain", () => {
		const { program, fn, condition } = validBranchProgram();
		const first = fn.kernel.valueFirstUse(condition);
		fn.kernel.useNext = () => first;
		expect(() => verifyCoreProgram(program)).toThrow(/invalid use-list chain/);
	});

	it("rejects a use count that disagrees with operand storage", () => {
		const { program, fn } = validBranchProgram();
		fn.kernel.valueUseCount = () => 0;
		expect(() => verifyCoreProgram(program)).toThrow(/use count does not match/);
	});

	it("rejects a live use row absent from operands and value chains", () => {
		const { program, fn, entry, condition } = validBranchProgram();
		const editor = CoreEditor.open(program, fn.id);
		const { instruction } = editor.appendInstruction(entry, "unary", [condition], {
			attributes: { operator: "!" },
		});
		const orphan = fn.kernel.operandUseAt(fn.kernel.instructionOperandStart(instruction));
		editor.removeInstruction(instruction);
		editor.commit();
		expect(() => verifyCoreProgram(program)).not.toThrow();
		const useLive = fn.kernel.useLive.bind(fn.kernel);
		fn.kernel.useLive = (use) => (use === orphan ? 1 : useLive(use));
		expect(() => verifyCoreProgram(program)).toThrow(/absent from its value chain/);
	});

	it("verifies store rows, definitions, uses, CFG indexes, and metadata", () => {
		const { program, fn, entry, consequent, alternate } = validBranchProgram();
		expect(() => verifyCoreProgram(program, { stage: "construction" })).not.toThrow();
		const cfg = buildCoreControlFlow(program, fn.id);
		expect(cfg.successors[entry]).toMatchObject([
			{ from: entry, to: consequent, kind: "ordinary" },
			{ from: entry, to: alternate, kind: "ordinary" },
		]);
		expect(cfg.predecessors[consequent]).toHaveLength(1);
		expect(cfg.dominates(entry, consequent)).toBe(true);
		program.seal();
		expect(() => verifyCoreProgram(program, { stage: "pre-target" })).not.toThrow();
	});

	it("accepts unmapped sentinels in duplicate-parameter argument metadata", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const value = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, { kind: "return", value });
		builder.configureFunction({
			parameterCount: 2,
			metadata: {
				mappedArguments: true,
				mappedArgumentSlots: [-1, 0],
				capturedCount: 1,
			},
		});
		builder.finish(entry);

		expect(() => verifyCoreProgram(program, { stage: "construction" })).not.toThrow();
	});

	it("rejects an edge whose arguments do not match its block parameters", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const target = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, target)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [] },
		});
		builder.setTerminator(target, { kind: "return", value: parameter });
		builder.finish(entry);
		expect(() =>
			verifyCoreProgram(program, { stage: "control-flow", pass: "test-pass" }),
		).toThrow(
			/Core IR verification failed \[stage=control-flow pass=test-pass function=0\]:.*passes 0 values to 1 parameters/,
		);
	});

	it("rejects exceptional flow without an exception entry parameter", () => {
		const { program, fn, entry, consequent } = validBranchProgram();
		const editor = CoreEditor.open(program, fn.id);
		editor.setHandler(entry, consequent);
		editor.commit();
		expect(() => verifyCoreProgram(program)).toThrow(/lacks an exception parameter/);
	});

	it("rejects source positions and proof references outside their program tables", () => {
		const badPosition = new CoreProgram(coreOpcodeRegistry);
		const positionBuilder = new CoreFunctionBuilder(badPosition);
		const positionEntry = positionBuilder.createBlock();
		const [positionValue] = positionBuilder.appendInstruction(
			positionEntry,
			"createUndefined",
			[],
			{ sourcePosition: 4 },
		);
		positionBuilder.setTerminator(positionEntry, {
			kind: "return",
			value: positionValue!,
		});
		positionBuilder.finish(positionEntry);
		expect(() => verifyCoreProgram(badPosition)).toThrow(/invalid source position 4/);

		const badProof = new CoreProgram(coreOpcodeRegistry);
		const proofBuilder = new CoreFunctionBuilder(badProof);
		const proofEntry = proofBuilder.createBlock();
		const [proofValue] = proofBuilder.appendInstruction(
			proofEntry,
			"createUndefined",
			[],
			{
				effectRefinement: { effects: CORE_NO_EFFECTS, proof: coreFactId(99) },
			},
		);
		proofBuilder.setTerminator(proofEntry, { kind: "return", value: proofValue! });
		proofBuilder.finish(proofEntry);
		expect(() => verifyCoreProgram(badProof)).toThrow(/references deleted fact !99/);
	});

	it("separates local verification from cross-function contracts", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 99 },
		});
		builder.setTerminator(entry, { kind: "return", value: created! });
		const finished = builder.finish(entry);
		expect(() => verifyCoreFunction(program, finished.function)).not.toThrow();
		expect(() => verifyCoreProgram(program)).toThrow(/references function 99/);
	});

	it("rejects negative function references except captured-scope owners", () => {
		const invalidProgram = new CoreProgram(coreOpcodeRegistry);
		const invalidBuilder = new CoreFunctionBuilder(invalidProgram);
		const invalidEntry = invalidBuilder.createBlock();
		const [invalidFunction] = invalidBuilder.appendInstruction(
			invalidEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: -1 } },
		);
		invalidBuilder.setTerminator(invalidEntry, {
			kind: "return",
			value: invalidFunction!,
		});
		invalidBuilder.finish(invalidEntry);
		expect(() => verifyCoreProgram(invalidProgram)).toThrow(/references function -1/);

		const capturedProgram = new CoreProgram(coreOpcodeRegistry);
		const capturedBuilder = new CoreFunctionBuilder(capturedProgram);
		const capturedEntry = capturedBuilder.createBlock();
		const [captured] = capturedBuilder.appendInstruction(
			capturedEntry,
			"loadCaptured",
			[],
			{ attributes: { functionIndex: -1, index: 0 } },
		);
		capturedBuilder.setTerminator(capturedEntry, {
			kind: "return",
			value: captured!,
		});
		capturedBuilder.finish(capturedEntry);
		expect(() => verifyCoreProgram(capturedProgram)).not.toThrow();
	});

	it("verifies every operation-carried cross-function reference", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, receiver!], {
			attributes: { guardedFunctionIndices: [-1] },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.finish(entry);
		expect(() => verifyCoreProgram(program)).toThrow(/references function -1/);
	});

	it("verifies function and slot references in compilation context", () => {
		const { program } = validBranchProgram();
		const base = programAnalysisContext();
		const valid = {
			...base,
			data: {
				...base.data,
				cjsModuleFunctionIndices: [0],
				singleAssignmentCapturedSlots: [{ owner: -1, index: 3 }],
			},
		};
		expect(() => verifyCoreProgram(program, undefined, valid)).not.toThrow();
		expect(() =>
			verifyCoreProgram(program, undefined, {
				...base,
				data: { ...base.data, cjsModuleFunctionIndices: [1] },
			}),
		).toThrow(/CJS module references function 1/);
		expect(() =>
			verifyCoreProgram(program, undefined, {
				...base,
				data: {
					...base.data,
					singleAssignmentCapturedSlots: [{ owner: 1, index: 0 }],
				},
			}),
		).toThrow(/captured slot references function 1/);
		expect(() =>
			verifyCoreProgram(program, undefined, {
				...base,
				data: { ...base.data, singleAssignmentGlobalSlots: [0] },
			}),
		).toThrow(/invalid global slot 0/);
	});

	it("incrementally verifies one change set and keys CFG indexes by relevant versions", () => {
		const { program, fn, entry, consequent, alternate } = validBranchProgram();
		const analyses = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const request = { scope: "function", function: fn.id } as const;
		const bundle = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
		const first = bundle.ordinary();
		const representationEditor = CoreEditor.open(program, fn.id);
		const condition = inspectCoreInstructionResults(
			fn,
			[...fn.bodyInstructionIds(entry)][0]!,
		)[0]!;
		representationEditor.setValueRepresentation(condition, "boolean");
		const representationChanges = representationEditor.commit();
		verifyCoreChangeSet(program, representationChanges, { stage: "canonicalize" });
		expect(analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request)).toBe(bundle);
		expect(bundle.ordinary()).toBe(first);

		const cfgEditor = CoreEditor.open(program, fn.id);
		cfgEditor.removeInstruction(fn.blockTerminator(entry));
		cfgEditor.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: alternate, arguments: [] },
			alternate: { block: consequent, arguments: [] },
		});
		const cfgChanges = cfgEditor.commit();
		verifyCoreChangeSet(program, cfgChanges, { stage: "control-flow" });
		expect(analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request)).toBe(bundle);
		expect(bundle.ordinary()).not.toBe(first);
	});

	it("formats the store through read-only lookup and iteration", () => {
		const { program, fn } = validBranchProgram();
		const formatted = formatCoreFunction(program, fn.id);
		expect(formatted).toContain("core function 0()");
		expect(formatted).toContain("createBoolean()");
		expect(formatted).toContain("branch %0, b1(), b2()");
	});
});
