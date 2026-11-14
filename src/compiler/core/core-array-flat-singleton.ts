import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import type { CoreArrayIterationCall } from "./core-array-iteration.ts";
import type { CoreEditor } from "./core-editor.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

interface FlatSingletonPlan {
	readonly allocation: CoreInstructionId;
	readonly definition: CoreInstructionId;
	readonly producer: CoreInstructionId;
	readonly lookup: CoreInstructionId;
	readonly element: CoreValueId;
}

/** Requires the private default-species proof from `coreArrayIterationNeedsGuard`. */
export function coreArrayFlatSingleton(
	fn: CoreFunctionStore,
	call: CoreArrayIterationCall,
	callback: CoreFunctionStore,
): FlatSingletonPlan | undefined {
	if (!["some", "every", "forEach"].includes(call.name)) return undefined;
	// The third callback argument would expose the elided result's identity and length.
	if (
		callback.parameterCount > 2 &&
		(callback.valueUseCount(callback.kernel.functionParameter(2)) !== 0 ||
			callback.kernel.valueHandlerUseCount(callback.kernel.functionParameter(2)) !== 0)
	)
		return undefined;
	for (const instruction of callback.instructionIds()) {
		if (callback.instructionKind(instruction) !== "operation") continue;
		const opcode = callback.instructionOpcodeName(instruction);
		if (
			(opcode === "loadArgument" || opcode === "loadStaticArgument") &&
			callback.instructionAttributes(instruction).index === 2
		)
			return undefined;
	}
	const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(call.receiver));
	const source = fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer));
	const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(source));
	const length = fn.instructionAttributes(allocation).length;
	if (length !== 0 && length !== 1) return undefined;
	const block = fn.instructionBlock(producer);
	if (fn.instructionBlock(allocation) !== block) return undefined;
	let definition: CoreInstructionId | undefined;
	for (
		let use = fn.kernel.valueFirstUse(source);
		use >= 0;
		use = fn.kernel.useNext(use)
	) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (instruction === producer) continue;
		if (definition !== undefined || fn.instructionBlock(instruction) !== block)
			return undefined;
		definition = instruction;
	}
	if (definition === undefined) return undefined;
	const start = fn.kernel.instructionOperandStart(definition);
	const key = fn.kernel.operandAt(start + 1);
	const keyDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
	if (fn.instructionAttributes(keyDefinition).value !== 0) return undefined;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(call.callee));
	if (
		fn.instructionBlock(lookup) !== block ||
		fn.valueUseCount(call.callee) !== 1 ||
		fn.kernel.valueHandlerUseCount(call.callee) !== 0
	)
		return undefined;
	let foundDefinition = false;
	let budget = 256;
	for (
		let instruction = fn.instructionNext(allocation);
		instruction !== undefined;
		instruction = fn.instructionNext(instruction)
	) {
		if (--budget < 0) return undefined;
		if (instruction === definition) foundDefinition = true;
		if (instruction === producer)
			return foundDefinition
				? {
						allocation,
						definition,
						producer,
						lookup,
						element: fn.kernel.operandAt(start + 2),
					}
				: undefined;
	}
	return undefined;
}

/** Keeps FlattenIntoArray's complete snapshot on the Array branch. */
export function expandCoreArrayFlatSingleton(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	call: CoreArrayIterationCall,
	plan: FlatSingletonPlan,
): {
	readonly call: CoreArrayIterationCall;
	readonly isArray: CoreValueId;
	readonly element: CoreValueId;
	readonly lookup: CoreInstructionId;
} {
	const block = fn.instructionBlock(plan.producer);
	const terminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(plan.producer);
	const array = editor.createBlock();
	const continuation = editor.createBlock([{}]);
	const receiver = fn.kernel.blockParameterValue(
		fn.kernel.blockParameterStart(continuation),
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(plan.producer);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	for (const instruction of tail) editor.moveInstruction(instruction, continuation);
	editor.setTerminator(continuation, coreTerminatorInput(fn, terminator));
	editor.removeInstruction(terminator);
	editor.replaceValueUses(call.receiver, receiver);
	for (const instruction of [plan.allocation, plan.definition, plan.producer])
		editor.moveInstruction(instruction, array);
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const args = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		);
		editor.setHandler(array, handler, args);
		editor.setHandler(continuation, handler, args);
	}
	const undefinedValue = editor.appendInstruction(block, "createUndefined", [], {
		sourcePosition,
	}).outputs[0]!;
	// The builtin follows Proxy targets without traps and throws for a revoked Proxy,
	// at the original flat call, before callback creation or argument evaluation.
	const isArray = editor.appendInstruction(
		block,
		"callKnown",
		[undefinedValue, plan.element],
		{
			attributes: {
				operation: "Array.isArray",
				worldAssumptions: {
					...builtinWorldAssumptions("Array.isArray", "exact-builtin-proof", true),
				},
			},
			sourcePosition,
		},
	).outputs[0]!;
	editor.setTerminator(block, {
		kind: "branch",
		condition: isArray,
		consequent: { block: array, arguments: [] },
		alternate: { block: continuation, arguments: [undefinedValue] },
		sourcePosition,
	});
	editor.setTerminator(array, {
		kind: "jump",
		edge: { block: continuation, arguments: [call.receiver] },
		sourcePosition,
	});
	return {
		call: { ...call, receiver },
		isArray,
		element: plan.element,
		lookup: plan.lookup,
	};
}
