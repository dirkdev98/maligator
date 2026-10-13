import { ARRAY_INITIALIZATION_LIMITS } from "../shared/array-initialization.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_ALLOCATIONS } from "./core-function-features.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const IMMUTABLE_LITERALS = new Set(["createString", "createNull", "createUndefined"]);

const SCALAR_PRODUCERS = new Set([
	"createNumber",
	"createF64",
	"createBoolean",
	"move",
	"binary",
	"unary",
	"mathBinaryNumber",
	"mathUnaryNumber",
]);

function operand(fn: CoreFunctionStore, instruction: CoreInstructionId, index: number) {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function numericIndex(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (
		fn.instructionKind(definition) !== "operation" ||
		!["createNumber", "createF64"].includes(fn.instructionOpcodeName(definition))
	)
		return undefined;
	const index = fn.instructionAttributes(definition).value;
	return typeof index === "number" ? index : undefined;
}

export const prepareFreshArrayValues: CoreFunctionPass = {
	name: "prepare-fresh-array-values",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createArray"],
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "memoryEffects", "representations"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		let kinds: CoreValueKindAnalysis | undefined;
		let editor: CoreEditor | undefined;
		let visited = 0,
			attempted = 0,
			edits = 0;
		const scalar = (value: CoreValueId): boolean => {
			const kind = (kinds ??= context.analysis(
				CORE_LOCAL_VALUE_KIND_ANALYSIS,
			)).scalarKind(value);
			return kind === "number" || kind === "boolean";
		};
		for (const allocation of fn.instructionIds()) {
			if (
				++visited > ARRAY_INITIALIZATION_LIMITS.maximumFunctionInstructions ||
				attempted >= ARRAY_INITIALIZATION_LIMITS.maximumCandidates
			)
				break;
			if (
				fn.instructionKind(allocation) !== "operation" ||
				fn.instructionOpcodeName(allocation) !== "createArray"
			)
				continue;
			const length = fn.instructionAttributes(allocation).length;
			if (
				typeof length !== "number" ||
				length < 2 ||
				length > ARRAY_INITIALIZATION_LIMITS.maximumLength
			)
				continue;
			attempted++;
			const receiver = fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation));
			const producers: Array<CoreInstructionId> = [];
			const produced = new Set<CoreValueId>();
			let initialized = 0,
				scanned = 0,
				preparesValue = false;
			for (
				let next = fn.instructionNext(allocation);
				next !== undefined &&
				++scanned <= ARRAY_INITIALIZATION_LIMITS.maximumInitializerInstructions &&
				fn.instructionKind(next) === "operation";
				next = fn.instructionNext(next)
			) {
				const opcode = fn.instructionOpcodeName(next);
				if (opcode === "defineProperty") {
					if (
						operand(fn, next, 0) !== receiver ||
						operand(fn, next, 2) === receiver ||
						fn.instructionAttributes(next).enumerable !== true ||
						fn.instructionAttributes(next).writable === false ||
						fn.instructionAttributes(next).configurable === false ||
						numericIndex(fn, operand(fn, next, 1)) !== initialized
					)
						break;
					preparesValue ||= produced.has(operand(fn, next, 2));
					if (++initialized === length) break;
					continue;
				}
				const literal = IMMUTABLE_LITERALS.has(opcode);
				if (!literal && !SCALAR_PRODUCERS.has(opcode)) break;
				const effects = coreInstructionEffects(fn, next);
				if (
					effects.mayThrow ||
					effects.mayGc ||
					effects.maySuspend ||
					effects.callsUserCode ||
					effects.reads.length !== 0 ||
					effects.writes.length !== 0 ||
					fn.kernel.instructionResultCount(next) !== 1 ||
					(!literal &&
						!scalar(fn.kernel.resultAt(fn.kernel.instructionResultStart(next))))
				)
					break;
				let safe = true;
				for (let i = 0; i < fn.kernel.instructionOperandCount(next); i++) {
					const value = operand(fn, next, i);
					if (value === receiver || !scalar(value)) {
						safe = false;
						break;
					}
				}
				if (!safe) break;
				producers.push(next);
				produced.add(fn.kernel.resultAt(fn.kernel.instructionResultStart(next)));
			}
			if (initialized !== length || !preparesValue) continue;
			if (edits + producers.length > context.remainingEdits) {
				context.deferForBudget();
				break;
			}
			// Same-block effect-free producers cannot observe the unpublished array or alter its initializers.
			editor ??= CoreEditor.open(program, item.function);
			for (const producer of producers)
				editor.moveInstruction(producer, fn.instructionBlock(allocation), allocation);
			edits += producers.length;
		}
		return editor?.commit();
	},
};
