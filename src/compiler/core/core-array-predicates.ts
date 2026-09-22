import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreArrayPredicateCall {
	readonly name: "some" | "every";
	readonly callee: CoreValueId;
	readonly receiver: CoreValueId;
	readonly callback: CoreValueId;
	readonly thisArgument?: CoreValueId;
}

export function coreArrayPredicateCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): CoreArrayPredicateCall | undefined {
	if (
		fn.instructionOpcodeName(site) !== "call" ||
		fn.kernel.instructionResultCount(site) !== 1
	)
		return undefined;
	const count = fn.kernel.instructionOperandCount(site);
	if (count !== 3 && count !== 4) return undefined;
	const start = fn.kernel.instructionOperandStart(site);
	const callee = fn.kernel.operandAt(start);
	if (fn.kernel.valueDefinitionKind(callee) !== 1) return undefined;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
	if (fn.instructionOpcodeName(lookup) !== "loadPropertyStatic") return undefined;
	const units =
		program.stringConstants[fn.instructionAttributes(lookup).stringIndex as number];
	if (units === undefined || (units.length !== 4 && units.length !== 5)) return undefined;
	const name = String.fromCharCode(...units);
	if (name !== "some" && name !== "every") return undefined;
	if (fn.instructionKind(fn.blockTerminator(fn.instructionBlock(site))) === "guard")
		return undefined;
	return {
		name,
		callee,
		receiver: fn.kernel.operandAt(start + 1),
		callback: fn.kernel.operandAt(start + 2),
		...(count === 4 ? { thisArgument: fn.kernel.operandAt(start + 3) } : {}),
	};
}

// The caller admits the loop and callback inline together before expanding either graph.
export function expandCoreArrayPredicateCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreArrayPredicateCall,
): {
	readonly callback: CoreInstructionId;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
} {
	const block = fn.instructionBlock(site);
	const originalTerminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(site);
	const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(site));
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(site);
		next !== undefined && next !== originalTerminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	const fallback = editor.createBlock();
	const fast = editor.createBlock();
	const header = editor.createBlock([{}]);
	const present = editor.createBlock();
	const invoke = editor.createBlock();
	const increment = editor.createBlock();
	const normalExit = editor.createBlock();
	const earlyExit = editor.createBlock();
	const join = editor.createBlock([{ representation: fn.valueRepresentation(result) }]);
	const blocks = [
		fallback,
		fast,
		header,
		present,
		invoke,
		increment,
		normalExit,
		earlyExit,
		join,
	];
	const joined = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join));
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.replaceValueUses(result, joined);
	editor.setTerminator(join, {
		...coreTerminatorInput(fn, originalTerminator),
		sourcePosition: fn.instructionSourcePosition(originalTerminator),
	});
	editor.removeInstruction(originalTerminator);
	editor.moveInstruction(site, fallback);
	const operands = [
		call.callee,
		call.receiver,
		call.callback,
		...(call.thisArgument === undefined ? [] : [call.thisArgument]),
	];
	editor.replaceInstruction(site, "call", operands, {
		attributes: {
			...fn.instructionAttributes(site),
			[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
		},
		sourcePosition,
		effectRefinement: fn.instructionEffectRefinement(site),
	});
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const args = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		);
		for (const created of blocks) editor.setHandler(created, handler, args);
	}
	let instructionsIntroduced = 0;
	const append = (
		destination: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId> = [],
		attributes: Readonly<Record<string, CoreAttributeValue>> = {},
	) => {
		instructionsIntroduced++;
		return editor.appendInstruction(destination, opcode, inputs, {
			attributes,
			sourcePosition,
		});
	};
	const jump = (from: CoreBlockId, to: CoreBlockId, args: Array<CoreValueId> = []) =>
		editor.setTerminator(from, {
			kind: "jump",
			edge: { block: to, arguments: args },
			sourcePosition,
		});
	const branch = (
		from: CoreBlockId,
		condition: CoreValueId,
		yes: CoreBlockId,
		no: CoreBlockId,
	) =>
		editor.setTerminator(from, {
			kind: "branch",
			condition,
			consequent: { block: yes, arguments: [] },
			alternate: { block: no, arguments: [] },
			sourcePosition,
		});
	jump(fallback, join, [result]);
	const undefinedValue = append(block, "createUndefined").outputs[0]!;
	const guard = append(block, "loadIntrinsic", [], {
		intrinsic: "__arrayIterationEligible",
	}).outputs[0]!;
	const method = append(block, "createNumber", [], {
		value: call.name === "some" ? 1 : 2,
	}).outputs[0]!;
	// Exact created callbacks are callable; avoiding a guard use permits capture virtualization.
	const eligible = append(block, "call", [
		guard,
		undefinedValue,
		call.callee,
		call.receiver,
		method,
		call.callee,
	]).outputs[0]!;
	branch(block, eligible, fast, fallback);
	const lengthKey = editor.appendStringConstants([
		[..."length"].map((unit) => unit.charCodeAt(0)),
	]);
	const length = append(fast, "loadPropertyStatic", [call.receiver], {
		stringIndex: lengthKey,
	}).outputs[0]!;
	const zero = append(fast, "createNumber", [], { value: 0 }).outputs[0]!;
	const one = append(fast, "createNumber", [], { value: 1 }).outputs[0]!;
	jump(fast, header, [zero]);
	const index = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(header));
	const withinLength = append(header, "binary", [index, length], { operator: "<" })
		.outputs[0]!;
	branch(header, withinLength, present, normalExit);
	const exists = append(present, "binary", [index, call.receiver], { operator: "in" })
		.outputs[0]!;
	branch(present, exists, invoke, increment);
	const element = append(invoke, "loadProperty", [call.receiver, index]).outputs[0]!;
	const callback = append(invoke, "call", [
		call.callback,
		call.thisArgument ?? undefinedValue,
		element,
		index,
		call.receiver,
	]);
	branch(
		invoke,
		callback.outputs[0]!,
		call.name === "some" ? earlyExit : increment,
		call.name === "some" ? increment : earlyExit,
	);
	const next = append(increment, "binary", [index, one], { operator: "+" }).outputs[0]!;
	jump(increment, header, [next]);
	const normal = append(normalExit, "createBoolean", [], { value: call.name === "every" })
		.outputs[0]!;
	const early = append(earlyExit, "createBoolean", [], { value: call.name === "some" })
		.outputs[0]!;
	jump(normalExit, join, [normal]);
	jump(earlyExit, join, [early]);
	return {
		callback: callback.instruction,
		instructionsIntroduced,
		blocksIntroduced: blocks.length,
	};
}
