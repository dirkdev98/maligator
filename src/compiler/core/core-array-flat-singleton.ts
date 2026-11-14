import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import type { CoreArrayIterationCall } from "./core-array-iteration.ts";
import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface FlatSingletonPlan {
	readonly allocation: CoreInstructionId;
	readonly definition: CoreInstructionId;
	readonly producer: CoreInstructionId;
	readonly lookup: CoreInstructionId;
	readonly element: CoreValueId;
	readonly flatLookup?: CoreInstructionId;
	readonly classification?: CoreValueId;
}

function callbackObservesArray(callback: CoreFunctionStore): boolean {
	// The third callback argument would expose the elided result's identity and length.
	if (
		callback.parameterCount > 2 &&
		(callback.valueUseCount(callback.kernel.functionParameter(2)) !== 0 ||
			callback.kernel.valueHandlerUseCount(callback.kernel.functionParameter(2)) !== 0)
	)
		return true;
	for (const instruction of callback.instructionIds()) {
		if (callback.instructionKind(instruction) !== "operation") continue;
		const opcode = callback.instructionOpcodeName(instruction);
		if (
			(opcode === "loadArgument" || opcode === "loadStaticArgument") &&
			callback.instructionAttributes(instruction).index === 2
		)
			return true;
	}
	return false;
}

/** Requires the private default-species proof from `coreArrayIterationNeedsGuard`. */
export function coreArrayFlatSingleton(
	fn: CoreFunctionStore,
	call: CoreArrayIterationCall,
	callback: CoreFunctionStore,
): FlatSingletonPlan | undefined {
	if (
		!["some", "every", "forEach"].includes(call.name) ||
		callbackObservesArray(callback)
	)
		return undefined;
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
	for (const instruction of [
		plan.allocation,
		plan.definition,
		...(plan.flatLookup === undefined ? [] : [plan.flatLookup]),
		plan.producer,
	])
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
	// The guarded path already classified the element without invoking Proxy traps.
	const isArray =
		plan.classification === undefined
			? editor.appendInstruction(block, "callKnown", [undefinedValue, plan.element], {
					attributes: {
						operation: "Array.isArray",
						worldAssumptions: {
							...builtinWorldAssumptions("Array.isArray", "exact-builtin-proof", true),
						},
					},
					sourcePosition,
				}).outputs[0]!
			: editor.appendInstruction(
					block,
					"binary",
					[
						plan.classification,
						editor.appendInstruction(block, "createNumber", [], {
							attributes: { value: 2 },
							sourcePosition,
						}).outputs[0]!,
					],
					{ attributes: { operator: "===" }, sourcePosition },
				).outputs[0]!;
	editor.setTerminator(block, {
		kind: "branch",
		condition: isArray,
		consequent: { block: array, arguments: [] },
		alternate: { block: continuation, arguments: [undefinedValue] },
		sourcePosition,
	});
	let snapshot = call.receiver;
	if (plan.classification !== undefined) {
		// The guard rules out every user-code seam in this copy. The existing append
		// intrinsic compacts holes at depth one without constructing a wrapper Array.
		for (const instruction of [
			plan.producer,
			plan.flatLookup!,
			plan.definition,
			plan.allocation,
		])
			editor.removeInstruction(instruction);
		snapshot = editor.appendInstruction(array, "createArray", [], {
			attributes: { length: 0 },
			sourcePosition,
		}).outputs[0]!;
		const append = editor.appendInstruction(array, "loadIntrinsic", [], {
			attributes: { intrinsic: "__arrayFlatMapAppend" },
			sourcePosition,
		}).outputs[0]!;
		editor.appendInstruction(
			array,
			"call",
			[append, undefinedValue, snapshot, plan.element],
			{ sourcePosition },
		);
	}
	editor.setTerminator(array, {
		kind: "jump",
		edge: { block: continuation, arguments: [snapshot] },
		sourcePosition,
	});
	return {
		call: { ...call, receiver },
		isArray,
		element: plan.element,
		lookup: plan.lookup,
	};
}

interface GuardedFlatSingletonPlan extends FlatSingletonPlan {
	readonly flatLookup: CoreInstructionId;
	readonly method: number;
}

function guardedFlatMethod(name: CoreArrayIterationCall["name"]): number | undefined {
	switch (name) {
		case "forEach":
			return 16;
		case "some":
			return 17;
		case "every":
			return 18;
		default:
			return undefined;
	}
}

/** Admits only private wrappers and an effect-free seam from flat to iteration. */
export function coreGuardedArrayFlatSingleton(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
	call: CoreArrayIterationCall,
	callback: CoreFunctionStore,
): GuardedFlatSingletonPlan | undefined {
	const method = guardedFlatMethod(call.name);
	if (method === undefined || callbackObservesArray(callback)) return undefined;
	if (fn.kernel.valueDefinitionKind(call.receiver) !== 1) return undefined;
	const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(call.receiver));
	if (
		fn.instructionOpcodeName(producer) !== "call" ||
		fn.kernel.instructionOperandCount(producer) !== 2 ||
		fn.instructionAttributes(producer).argumentMode !== undefined
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(producer);
	const callee = fn.kernel.operandAt(start);
	const source = fn.kernel.operandAt(start + 1);
	if (
		fn.kernel.valueDefinitionKind(callee) !== 1 ||
		fn.kernel.valueDefinitionKind(source) !== 1
	)
		return undefined;
	const flatLookup = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
	const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(source));
	const units =
		program.stringConstants[fn.instructionAttributes(flatLookup).stringIndex as number];
	if (
		fn.instructionOpcodeName(flatLookup) !== "loadPropertyStatic" ||
		units === undefined ||
		units.length !== 4 ||
		String.fromCharCode(...units) !== "flat" ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(flatLookup)) !== source ||
		fn.instructionOpcodeName(allocation) !== "createArray" ||
		fn.valueUseCount(callee) !== 1 ||
		fn.kernel.valueHandlerUseCount(callee) !== 0
	)
		return undefined;
	const length = fn.instructionAttributes(allocation).length;
	if (length !== 0 && length !== 1) return undefined;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(call.callee));
	const block = fn.instructionBlock(producer);
	if (
		[allocation, flatLookup, lookup, site].some(
			(instruction) => fn.instructionBlock(instruction) !== block,
		)
	)
		return undefined;
	if (
		fn.valueUseCount(call.callee) !== 1 ||
		fn.kernel.valueHandlerUseCount(call.callee) !== 0
	)
		return undefined;
	let definition: CoreInstructionId | undefined;
	for (const value of [source, call.receiver]) {
		if (fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
		let budget = 256;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (--budget < 0) return undefined;
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = coreInstructionId(fn.kernel.useInstruction(use));
			const operand = fn.kernel.useOperand(use);
			if (value === call.receiver) {
				if (
					(instruction === site && operand === 1) ||
					(instruction === lookup && operand === 0)
				)
					continue;
				return undefined;
			}
			if (
				(instruction === producer && operand === 1) ||
				(instruction === flatLookup && operand === 0)
			)
				continue;
			if (
				definition !== undefined ||
				fn.instructionBlock(instruction) !== block ||
				fn.instructionOpcodeName(instruction) !== "defineProperty" ||
				operand !== 0
			)
				return undefined;
			definition = instruction;
		}
	}
	if (definition === undefined) return undefined;
	const definitionStart = fn.kernel.instructionOperandStart(definition);
	const key = fn.kernel.operandAt(definitionStart + 1);
	if (fn.kernel.valueDefinitionKind(key) !== 1) return undefined;
	const keyDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
	if (
		!["createNumber", "createI32", "createF64"].includes(
			fn.instructionOpcodeName(keyDefinition),
		) ||
		fn.instructionAttributes(keyDefinition).value !== 0
	)
		return undefined;
	let reachedProducer = false;
	let reachedLookup = false;
	let budget = 256;
	for (
		let instruction = fn.instructionNext(definition);
		instruction !== undefined;
		instruction = fn.instructionNext(instruction)
	) {
		if (--budget < 0) return undefined;
		if (instruction === flatLookup) {
			reachedLookup = true;
			continue;
		}
		if (instruction === producer) {
			if (!reachedLookup) return undefined;
			reachedProducer = true;
			continue;
		}
		if (instruction === site)
			return reachedProducer
				? {
						allocation,
						definition,
						producer,
						lookup,
						flatLookup,
						method,
						element: fn.kernel.operandAt(definitionStart + 2),
					}
				: undefined;
		if (instruction === lookup && reachedProducer) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			![
				"createUndefined",
				"createNumber",
				"createI32",
				"createF64",
				"createString",
				"createBoolean",
				"createFunction",
			].includes(opcode)
		)
			return undefined;
	}
	return undefined;
}

/** Versions the complete observable sequence before erasing allocations on its fast arm. */
export function expandGuardedCoreArrayFlatSingleton(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreArrayIterationCall,
	plan: GuardedFlatSingletonPlan,
): {
	readonly site: CoreInstructionId;
	readonly call: CoreArrayIterationCall;
	readonly plan: FlatSingletonPlan;
} {
	const block = fn.instructionBlock(site);
	const terminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(plan.producer);
	const fallback = editor.createBlock();
	const fast = editor.createBlock();
	const join = editor.createBlock([{}]);
	const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(site));
	const joined = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join));
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(site);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.setTerminator(join, coreTerminatorInput(fn, terminator));
	editor.removeInstruction(terminator);
	editor.replaceValueUses(result, joined);
	const clone = (instruction: CoreInstructionId, inputs?: ReadonlyArray<CoreValueId>) =>
		editor.appendInstruction(
			fast,
			fn.instructionOpcodeName(instruction),
			inputs ??
				Array.from({ length: fn.kernel.instructionOperandCount(instruction) }, (_, i) =>
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + i),
				),
			{
				attributes: fn.instructionAttributes(instruction),
				outputCount: fn.kernel.instructionResultCount(instruction),
				sourcePosition: fn.instructionSourcePosition(instruction),
			},
		);
	const allocation = clone(plan.allocation);
	const source = allocation.outputs[0]!;
	const definitionStart = fn.kernel.instructionOperandStart(plan.definition);
	const definition = clone(plan.definition, [
		source,
		fn.kernel.operandAt(definitionStart + 1),
		plan.element,
	]);
	const flatLookup = clone(plan.flatLookup, [source]);
	const producer = clone(plan.producer, [flatLookup.outputs[0]!, source]);
	const undefinedValue = editor.appendInstruction(block, "createUndefined", [], {
		sourcePosition,
	}).outputs[0]!;
	const fastCall = { ...call, callee: undefinedValue, receiver: producer.outputs[0]! };
	const invocation = clone(site, [
		undefinedValue,
		fastCall.receiver,
		call.callback,
		...(call.secondArgument === undefined ? [] : [call.secondArgument]),
	]);
	for (const instruction of [
		plan.allocation,
		plan.definition,
		plan.flatLookup,
		plan.producer,
		plan.lookup,
		site,
	])
		editor.moveInstruction(instruction, fallback);
	editor.replaceInstruction(
		site,
		"call",
		[
			call.callee,
			call.receiver,
			call.callback,
			...(call.secondArgument === undefined ? [] : [call.secondArgument]),
		],
		{
			attributes: {
				...fn.instructionAttributes(site),
				[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
			},
			sourcePosition: fn.instructionSourcePosition(site),
		},
	);
	const guard = editor.appendInstruction(block, "loadIntrinsic", [], {
		attributes: { intrinsic: "__arrayIterationEligible" },
		sourcePosition,
	}).outputs[0]!;
	const method = editor.appendInstruction(block, "createNumber", [], {
		attributes: { value: plan.method },
		sourcePosition,
	}).outputs[0]!;
	const classification = editor.appendInstruction(
		block,
		"call",
		[guard, undefinedValue, undefinedValue, plan.element, method, undefinedValue],
		{ sourcePosition },
	).outputs[0]!;
	editor.setTerminator(block, {
		kind: "branch",
		condition: classification,
		consequent: { block: fast, arguments: [] },
		alternate: { block: fallback, arguments: [] },
		sourcePosition,
	});
	for (const [from, value] of [
		[fallback, result],
		[fast, invocation.outputs[0]!],
	] as const)
		editor.setTerminator(from, {
			kind: "jump",
			edge: { block: join, arguments: [value] },
			sourcePosition,
		});
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const args = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, i) => fn.kernel.handlerArgumentAt(start + i),
		);
		for (const created of [fallback, fast, join])
			editor.setHandler(created, handler, args);
	}
	return {
		site: invocation.instruction,
		call: fastCall,
		plan: {
			...plan,
			allocation: allocation.instruction,
			definition: definition.instruction,
			producer: producer.instruction,
			flatLookup: flatLookup.instruction,
			classification,
		},
	};
}
