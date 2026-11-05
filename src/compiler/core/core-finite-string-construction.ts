import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeInstructionAndOwnedProof } from "./core-effect-proof-edits.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

function definition(fn: CoreFunctionStore, value: CoreValueId) {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function operand(fn: CoreFunctionStore, instruction: CoreInstructionId, index = 0) {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function constantString(program: CoreProgram, fn: CoreFunctionStore, value: CoreValueId) {
	const instruction = definition(fn, value);
	if (
		instruction === undefined ||
		fn.instructionOpcodeName(instruction) !== "createString"
	)
		return undefined;
	const index = fn.instructionAttributes(instruction).stringIndex;
	return typeof index === "number" ? program.stringConstantText(index) : undefined;
}

function construction(
	program: CoreProgram,
	fn: CoreFunctionStore,
	call: CoreInstructionId,
) {
	const count = fn.kernel.instructionOperandCount(call);
	if (count < 2 || count > 8) return undefined;
	const parts: Array<string | null> = [];
	let conversion: CoreInstructionId | undefined;
	let converted: CoreValueId | undefined;
	for (let index = 0; index < count; index++) {
		const value = operand(fn, call, index);
		const constant = constantString(program, fn, value);
		if (constant !== undefined) {
			parts.push(constant);
			continue;
		}
		const instruction = definition(fn, value);
		if (
			conversion !== undefined ||
			instruction === undefined ||
			fn.instructionOpcodeName(instruction) !== "unary" ||
			fn.instructionAttributes(instruction).operator !== "tostring"
		)
			return undefined;
		conversion = instruction;
		converted = value;
		parts.push(null);
	}
	if (
		conversion === undefined ||
		converted === undefined ||
		fn.valueUseCount(converted) !== 1 ||
		fn.kernel.valueHandlerUseCount(converted) !== 0
	)
		return undefined;
	return { conversion, input: operand(fn, conversion), parts };
}

export const foldFiniteStringConstruction: CoreFunctionPass = {
	name: "fold-finite-string-construction",
	stage: "canonicalize",
	candidates: { dependencies: ["body"], opcodes: ["concatStrings"] },
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS, CORE_LOOP_INDUCTION_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "facts", "representations"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: { maxWorkItems: 32, maxEdits: 4096, exhaustion: "stop" },
	run(context) {
		const { program } = context;
		const fn = program.function(context.item.function);
		if (fn.isAsync || fn.isGenerator || fn.metadata.isClassConstructor) return undefined;
		for (const instruction of context.instructions()) {
			const block = fn.instructionBlock(instruction);
			if (fn.kernel.blockHandlerBlock(block) !== undefined) continue;
			const plan = construction(program, fn, instruction);
			if (plan === undefined) continue;
			// Primitive Number conversion cannot call prototype hooks or the String binding.
			if (
				context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS).kindMask(plan.input) !==
				COMPILER_VALUE_KIND_NUMBER
			)
				continue;
			const range = context
				.analysis(CORE_LOOP_INDUCTION_ANALYSIS)
				.range(plan.input, block);
			if (range === undefined || !range.exactSafeIntegers) continue;
			const count = range.maximum - range.minimum + 1;
			if (!Number.isSafeInteger(count) || count < 1 || count > 32) continue;
			const constantUnits = plan.parts.reduce(
				(sum, part) => sum + (part?.length ?? 0),
				0,
			);
			const numericUnits = Math.max(
				String(range.minimum).length,
				String(range.maximum).length,
			);
			if ((constantUnits + numericUnits) * count > 4096) continue;
			const strings = Array.from({ length: count }, (_, offset) =>
				plan.parts.map((part) => part ?? String(range.minimum + offset)).join(""),
			);
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const useCount = fn.valueUseCount(output) + fn.kernel.valueHandlerUseCount(output);
			if (useCount > 64) continue;
			const terminator = fn.blockTerminator(block);
			if (fn.instructionKind(terminator) === "guard") continue;
			const tail: Array<CoreInstructionId> = [];
			for (
				let next = fn.instructionNext(instruction);
				next !== undefined && next !== terminator && tail.length <= 128;
				next = fn.instructionNext(next)
			)
				tail.push(next);
			if (
				tail.length > 128 ||
				context.remainingEdits < count * 5 + tail.length + useCount * 2 + 32
			)
				continue;
			const editor = CoreEditor.open(program, fn.id);
			const continuation = editor.createBlock([
				{ representation: fn.valueRepresentation(output) },
			]);
			const selected = fn.kernel.blockParameterValue(
				fn.kernel.blockParameterStart(continuation),
			);
			for (const next of tail) editor.moveInstruction(next, continuation);
			editor.replaceValueUses(output, selected);
			editor.setTerminator(continuation, {
				...coreTerminatorInput(fn, terminator),
				sourcePosition: fn.instructionSourcePosition(terminator),
			});
			const edges = strings.map((text) => {
				const stringIndex =
					program.stringConstantSlot(text, "first") ??
					editor.appendStringConstants([
						Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)),
					]);
				const target = editor.createBlock();
				const constant = editor.appendInstruction(target, "createString", [], {
					attributes: { stringIndex },
					sourcePosition: fn.instructionSourcePosition(instruction),
				}).outputs[0]!;
				editor.setTerminator(target, {
					kind: "jump",
					edge: { block: continuation, arguments: [constant] },
				});
				return { block: target, arguments: [] };
			});
			editor.replaceTerminator(block, {
				kind: "switch",
				discriminant: plan.input,
				cases: edges.slice(0, -1).map((edge, offset) => ({
					value: { kind: "number", value: range.minimum + offset },
					edge,
				})),
				// The proven integer range makes the final case exhaustive.
				default: edges.at(-1)!,
			});
			removeInstructionAndOwnedProof(editor, fn, instruction);
			removeInstructionAndOwnedProof(editor, fn, plan.conversion);
			return editor.commit();
		}
		return undefined;
	},
};
