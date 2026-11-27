import { coreInstructionOperands } from "./core-debug-view.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const MAX_PREFIX_BLOCKS = 8;
const MAX_PREFIX_INSTRUCTIONS = 20;
const FRAME_OPERATIONS = new Set([
	"loadArgument",
	"loadArgumentCount",
	"loadCallee",
	"loadDynamicArgument",
	"loadNewTarget",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
	"createRestArgumentsState",
	"callRestArguments",
	"constructRestArguments",
]);

export interface CoreCapturedPrefix {
	readonly blocks: ReadonlyArray<CoreBlockId>;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly callback: CoreInstructionId;
	readonly callbackParameter: number;
	readonly probes: number;
}

function prefixInstruction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadPropertyStatic") return true;
	if (opcode === "storeCaptured")
		return fn.instructionAttributes(instruction).functionIndex === fn.id;
	// Strict equality does not coerce either operand, even on a replay.
	if (opcode === "binary") {
		const operator = fn.instructionAttributes(instruction).operator;
		return operator === "===" || operator === "!==";
	}
	const effects = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
	return (
		effects.reads.length === 0 &&
		effects.writes.length === 0 &&
		!effects.mayThrow &&
		!effects.callsUserCode &&
		!effects.mayGc &&
		!effects.maySuspend &&
		opcode !== "loadThis"
	);
}

/**
 * Speculate only through fresh activation stores and non-observable reads. The
 * original call can repeat them when a probe misses or the prefix reaches a tail.
 */
export function planCoreCapturedPrefix(
	fn: CoreFunctionStore,
): CoreCapturedPrefix | undefined {
	if (
		!fn.metadata.strict ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.isClassConstructor ||
		fn.metadata.mappedArguments ||
		fn.metadata.capturedCount === 0 ||
		fn.handlerBlockCount !== 0 ||
		fn.kernel.blockParameterCount(fn.entry) !== fn.parameterCount
	)
		return undefined;
	const parameters = Array.from({ length: fn.parameterCount }, (_, i) =>
		fn.kernel.functionParameter(i),
	);
	const ordered: Array<CoreBlockId> = [];
	const instructions: Array<CoreInstructionId> = [];
	const active = new Set<CoreBlockId>();
	const seen = new Set<CoreBlockId>();
	let callback: CoreInstructionId | undefined;
	let callbackParameter = -1;
	let probes = 0;
	let hasTail = false;
	const visit = (block: CoreBlockId): boolean => {
		if (active.has(block)) return false;
		if (seen.has(block)) return true;
		if (seen.size >= MAX_PREFIX_BLOCKS) return false;
		seen.add(block);
		const terminator = fn.blockTerminator(block);
		const exit = coreTerminatorInput(fn, terminator);
		let call: CoreInstructionId | undefined;
		let parameter = -1;
		if (exit.kind === "return" && fn.kernel.valueDefinitionKind(exit.value) === 1) {
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(exit.value));
			if (
				fn.instructionBlock(instruction) === block &&
				fn.instructionNext(instruction) === terminator &&
				fn.instructionOpcodeName(instruction) === "call" &&
				fn.valueUseCount(exit.value) === 1
			) {
				parameter = parameters.indexOf(coreInstructionOperands(fn, instruction)[0]!);
				if (parameter >= 0) call = instruction;
			}
		}
		const body = [...fn.bodyInstructionIds(block)];
		if (
			(block !== fn.entry && fn.kernel.blockParameterCount(block) !== 0) ||
			(exit.kind !== "branch" && exit.kind !== "jump" && call === undefined) ||
			body.some(
				(instruction) => instruction !== call && !prefixInstruction(fn, instruction),
			)
		) {
			hasTail = true;
			return true;
		}
		if (call !== undefined) {
			if (callback !== undefined) return false;
			callback = call;
			callbackParameter = parameter;
		}
		active.add(block);
		for (const instruction of body) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "storeCaptured") continue;
			if (opcode === "loadPropertyStatic") probes++;
			instructions.push(instruction);
		}
		if (instructions.length > MAX_PREFIX_INSTRUCTIONS) return false;
		if (exit.kind === "jump" && !visit(exit.edge.block)) return false;
		if (
			exit.kind === "branch" &&
			(!visit(exit.consequent.block) || !visit(exit.alternate.block))
		)
			return false;
		active.delete(block);
		ordered.push(block);
		return true;
	};
	if (!visit(fn.entry) || callback === undefined || !hasTail) return undefined;

	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) === "operation" &&
			FRAME_OPERATIONS.has(fn.instructionOpcodeName(instruction))
		)
			return undefined;
	}

	const value = parameters[callbackParameter]!;
	const cloned = new Set(instructions);
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (instruction === callback && fn.kernel.useOperand(use) === 0) continue;
		if (
			cloned.has(instruction) ||
			(fn.instructionKind(instruction) !== "operation" &&
				ordered.includes(fn.instructionBlock(instruction)))
		)
			return undefined;
	}
	ordered.reverse();
	return { blocks: ordered, instructions, callback, callbackParameter, probes };
}
