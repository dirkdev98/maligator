import { ARRAY_INITIALIZATION_LIMITS } from "../shared/array-initialization.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_ALLOCATIONS } from "./core-function-features.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const IMMUTABLE_LITERALS = new Set([
	"createString",
	"createBigint",
	"createNull",
	"createUndefined",
]);

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

function lengthKey(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const index = fn.instructionAttributes(instruction).stringIndex;
	const units = typeof index === "number" ? program.stringConstants[index] : undefined;
	return units !== undefined && String.fromCharCode(...units) === "length";
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

// Creation sets a literal's length; initializers below it and reads cannot change it.
export const foldLiteralArrayLengths: CoreFunctionPass = {
	name: "fold-literal-array-lengths",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createArray"],
	admission: {
		predicate: "array literal and a length read",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds())
				if (
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadPropertyStatic" &&
					lengthKey(program, fn, instruction)
				)
					return true;
			return false;
		},
	},
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["body", "cfg"],
	changes: { cfg: false, calls: false, facts: false, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, compilationContext, item } = context;
		const fn = program.function(item.function);
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
		const literals = new Map<
			CoreValueId,
			{ readonly length: number; readonly loads: Array<CoreInstructionId> }
		>();
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "createArray" ||
				fn.kernel.instructionResultCount(instruction) !== 1
			)
				continue;
			const length = fn.instructionAttributes(instruction).length;
			if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
				continue;
			literals.set(
				root(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))),
				{
					length,
					loads: [],
				},
			);
		}
		if (literals.size === 0) return undefined;
		const facts = compilationContext.facts;
		// A mutable prototype could answer an element read through an accessor that sees the array.
		const readable =
			facts.world.primordialPolicy === "locked" &&
			compilerFactIsWorldInvariant(facts.protectors.get("array-elements"));
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const rejected = new Set<CoreValueId>();
		for (const block of fn.blockIds()) {
			const start = fn.kernel.blockParameterStart(block);
			for (let index = 0; index < fn.kernel.blockParameterCount(block); index++) {
				if (fn.kernel.blockParameterRole(start + index) === 1) continue;
				const parameter = root(fn.kernel.blockParameterValue(start + index));
				for (const edge of control.predecessors[block] ?? []) {
					const argument =
						edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
					if (argument !== undefined && root(argument) !== parameter)
						rejected.add(root(argument));
				}
			}
			const input = coreTerminatorInput(fn, fn.blockTerminator(block));
			const observed =
				input.kind === "branch" || input.kind === "guard"
					? input.condition
					: input.kind === "switch"
						? input.discriminant
						: input.kind === "return" || input.kind === "throw"
							? input.value
							: undefined;
			if (observed !== undefined) rejected.add(root(observed));
		}
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			const count = fn.kernel.instructionOperandCount(instruction);
			for (let position = 0; position < count; position++) {
				const value = root(operand(fn, instruction, position));
				const literal = literals.get(value);
				if (literal === undefined || rejected.has(value)) continue;
				if (position === 0) {
					if (opcode === "move" || opcode === "rootUse" || opcode === "throwIfTdz")
						continue;
					if (
						opcode === "loadPropertyStatic" &&
						count === 1 &&
						lengthKey(program, fn, instruction)
					) {
						literal.loads.push(instruction);
						continue;
					}
					if (opcode === "loadProperty" && count === 2 && readable) continue;
					const index =
						opcode === "defineProperty" && count === 3
							? numericIndex(fn, operand(fn, instruction, 1))
							: undefined;
					if (
						index !== undefined &&
						Number.isInteger(index) &&
						index >= 0 &&
						index < literal.length
					)
						continue;
				}
				rejected.add(value);
			}
		}
		const folds = [...literals].flatMap(([value, { length, loads }]) =>
			rejected.has(value) ? [] : loads.map((load) => ({ load, length })),
		);
		if (folds.length === 0) return undefined;
		if (folds.length > context.remainingEdits) {
			context.deferForBudget();
			return undefined;
		}
		const editor = CoreEditor.open(program, item.function);
		for (const { load, length } of folds)
			editor.replaceInstruction(load, "createNumber", [], {
				attributes: { value: length },
				sourcePosition: fn.instructionSourcePosition(load),
			});
		return editor.commit();
	},
};
