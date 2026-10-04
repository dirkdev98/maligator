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

// Method ids accepted by the runtime's __arrayIterationEligible guard.
const ARRAY_ITERATION_METHOD_IDS = {
	forEach: 0,
	some: 1,
	every: 2,
	find: 3,
	findIndex: 4,
	map: 5,
	filter: 6,
	reduce: 7,
} as const;

export type CoreArrayIterationName = keyof typeof ARRAY_ITERATION_METHOD_IDS;

export interface CoreArrayIterationCall {
	readonly name: CoreArrayIterationName;
	readonly callee: CoreValueId;
	readonly receiver: CoreValueId;
	readonly callback: CoreValueId;
	// The callback's this, or reduce's initial value.
	readonly secondArgument?: CoreValueId;
}

function isArrayIterationName(name: string): name is CoreArrayIterationName {
	return Object.hasOwn(ARRAY_ITERATION_METHOD_IDS, name);
}

export function coreArrayIterationCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): CoreArrayIterationCall | undefined {
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
	if (units === undefined || units.length > 9) return undefined;
	const name = String.fromCharCode(...units);
	if (!isArrayIterationName(name)) return undefined;
	// Without an initial value, reduce seeds from the first present element or throws.
	if (name === "reduce" && count !== 4) return undefined;
	if (fn.instructionKind(fn.blockTerminator(fn.instructionBlock(site))) === "guard")
		return undefined;
	return {
		name,
		callee,
		receiver: fn.kernel.operandAt(start + 1),
		callback: fn.kernel.operandAt(start + 2),
		...(count === 4 ? { secondArgument: fn.kernel.operandAt(start + 3) } : {}),
	};
}

/*
 * Expands an eligible call into the method's specified loop: `length` is read once,
 * holes are skipped through HasProperty (find and findIndex read every index), and
 * map/filter create their default-species result before the loop. The result Array
 * stays unreachable from the callback, so CreateDataProperty is a plain define.
 * The caller admits the loop and callback inline together before expanding either graph.
 */
export function expandCoreArrayIterationCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreArrayIterationCall,
): {
	readonly callback: CoreInstructionId;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
} {
	const name = call.name;
	const filter = name === "filter";
	const reduce = name === "reduce";
	// filter carries its output index and reduce its accumulator beside the source index.
	const carries = filter || reduce;
	const finds = name === "find" || name === "findIndex";
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
	const header = editor.createBlock(carries ? [{}, {}] : [{}]);
	const present = finds ? undefined : editor.createBlock();
	const invoke = editor.createBlock();
	const select = filter ? editor.createBlock() : undefined;
	const increment = editor.createBlock(carries ? [{}] : []);
	const normalExit = editor.createBlock();
	const earlyExit =
		name === "some" || name === "every" || finds ? editor.createBlock() : undefined;
	const join = editor.createBlock([{ representation: fn.valueRepresentation(result) }]);
	const blocks = [
		fallback,
		fast,
		header,
		present,
		invoke,
		select,
		increment,
		normalExit,
		earlyExit,
		join,
	].filter((created) => created !== undefined);
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
		...(call.secondArgument === undefined ? [] : [call.secondArgument]),
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
		noArguments: Array<CoreValueId> = [],
	) =>
		editor.setTerminator(from, {
			kind: "branch",
			condition,
			consequent: { block: yes, arguments: [] },
			alternate: { block: no, arguments: noArguments },
			sourcePosition,
		});
	jump(fallback, join, [result]);
	const undefinedValue = append(block, "createUndefined").outputs[0]!;
	const guard = append(block, "loadIntrinsic", [], {
		intrinsic: "__arrayIterationEligible",
	}).outputs[0]!;
	const method = append(block, "createNumber", [], {
		value: ARRAY_ITERATION_METHOD_IDS[name],
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
	const created =
		name === "map" || filter
			? append(fast, "createArray", [], { length: 0 }).outputs[0]!
			: undefined;
	if (reduce) instructionsIntroduced++;
	// The accumulator also carries boxed callback results, so an unboxed seed boxes first.
	const seed = reduce
		? editor.appendInstruction(fast, "move", [call.secondArgument!], {
				sourcePosition,
				outputRepresentations: ["boxed"],
			}).outputs[0]!
		: undefined;
	jump(fast, header, filter ? [zero, zero] : seed !== undefined ? [zero, seed] : [zero]);
	const headerStart = fn.kernel.blockParameterStart(header);
	const index = fn.kernel.blockParameterValue(headerStart);
	const carried = carries ? [fn.kernel.blockParameterValue(headerStart + 1)] : [];
	const withinLength = append(header, "binary", [index, length], { operator: "<" })
		.outputs[0]!;
	branch(header, withinLength, present ?? invoke, normalExit);
	if (present !== undefined) {
		const exists = append(present, "binary", [index, call.receiver], { operator: "in" })
			.outputs[0]!;
		branch(present, exists, invoke, increment, carried);
	}
	const element = append(invoke, "loadProperty", [call.receiver, index]).outputs[0]!;
	const callback = append(
		invoke,
		"call",
		reduce
			? [call.callback, undefinedValue, carried[0]!, element, index, call.receiver]
			: [
					call.callback,
					call.secondArgument ?? undefinedValue,
					element,
					index,
					call.receiver,
				],
	);
	const returned = callback.outputs[0]!;
	switch (name) {
		case "some":
		case "find":
		case "findIndex":
			branch(invoke, returned, earlyExit!, increment);
			break;
		case "every":
			branch(invoke, returned, increment, earlyExit!);
			break;
		case "forEach":
			jump(invoke, increment);
			break;
		case "map":
			append(invoke, "defineProperty", [created!, index, returned], { enumerable: true });
			jump(invoke, increment);
			break;
		case "filter": {
			branch(invoke, returned, select!, increment, carried);
			append(select!, "defineProperty", [created!, carried[0]!, element], {
				enumerable: true,
			});
			const following = append(select!, "binary", [carried[0]!, one], { operator: "+" })
				.outputs[0]!;
			jump(select!, increment, [following]);
			break;
		}
		case "reduce":
			jump(invoke, increment, [returned]);
			break;
	}
	const next = append(increment, "binary", [index, one], { operator: "+" }).outputs[0]!;
	jump(
		increment,
		header,
		carries
			? [next, fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(increment))]
			: [next],
	);
	switch (name) {
		case "some":
		case "every":
			jump(normalExit, join, [
				append(normalExit, "createBoolean", [], { value: name === "every" }).outputs[0]!,
			]);
			jump(earlyExit!, join, [
				append(earlyExit!, "createBoolean", [], { value: name === "some" }).outputs[0]!,
			]);
			break;
		case "find":
			jump(normalExit, join, [undefinedValue]);
			jump(earlyExit!, join, [element]);
			break;
		case "findIndex":
			jump(normalExit, join, [
				append(normalExit, "createNumber", [], { value: -1 }).outputs[0]!,
			]);
			jump(earlyExit!, join, [index]);
			break;
		case "reduce":
			jump(normalExit, join, [carried[0]!]);
			break;
		case "forEach":
			jump(normalExit, join, [undefinedValue]);
			break;
		case "map":
			// Trailing holes leave the defines short of ArraySpeciesCreate's length.
			append(normalExit, "storePropertyStatic", [created!, length], {
				stringIndex: lengthKey,
			});
			jump(normalExit, join, [created!]);
			break;
		case "filter":
			jump(normalExit, join, [created!]);
			break;
	}
	return {
		callback: callback.instruction,
		instructionsIntroduced,
		blocksIntroduced: blocks.length,
	};
}
