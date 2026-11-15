import type { CoreCompilationContext } from "./core-compilation.ts";
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
	reduceRight: 8,
	findLast: 9,
	findLastIndex: 10,
	flatMap: 11,
} as const;

export type CoreArrayIterationName = keyof typeof ARRAY_ITERATION_METHOD_IDS;

export interface CoreArrayIterationCall {
	readonly name: CoreArrayIterationName;
	readonly callee: CoreValueId;
	readonly receiver: CoreValueId;
	readonly callback: CoreValueId;
	// The callback receiver or reduction initial value.
	readonly secondArgument?: CoreValueId;
}

function isArrayIterationName(name: string): name is CoreArrayIterationName {
	return Object.hasOwn(ARRAY_ITERATION_METHOD_IDS, name);
}

/**
 * Returning false proves the method, receiver and species checks cannot fail:
 * a private plain Array and the locked builtin graph prevent method replacement
 * or user-defined result construction before iteration.
 */
export function coreArrayIterationNeedsGuard(
	fn: CoreFunctionStore,
	site: CoreInstructionId,
	call: CoreArrayIterationCall,
	context: CoreCompilationContext,
): boolean {
	if (
		context.facts.world.primordialPolicy !== "locked" ||
		context.facts.world.realms ||
		fn.kernel.valueDefinitionKind(call.receiver) !== 1
	)
		return true;
	const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(call.receiver));
	const attributes = fn.instructionAttributes(producer);
	// flat chooses its species before reading elements and exposes only its completed
	// result. Numeric definitions on the private source cannot redirect that species.
	if (
		fn.instructionOpcodeName(producer) !== "callKnown" ||
		attributes.operation !== "Array.prototype.flat" ||
		attributes.construct ||
		attributes.argumentMode !== undefined ||
		fn.kernel.instructionOperandCount(producer) !== 1
	)
		return true;
	const source = fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer));
	if (fn.kernel.valueDefinitionKind(source) !== 1) return true;
	const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(source));
	if (fn.instructionOpcodeName(allocation) !== "createArray") return true;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(call.callee));
	if (fn.kernel.operandAt(fn.kernel.instructionOperandStart(lookup)) !== call.receiver)
		return true;
	let remainingUses = 256;
	for (const value of [source, call.receiver]) {
		if (fn.kernel.valueHandlerUseCount(value) !== 0) return true;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (--remainingUses < 0) return true;
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = coreInstructionId(fn.kernel.useInstruction(use));
			const operand = fn.kernel.useOperand(use);
			if (value === call.receiver) {
				if (
					(instruction === site && operand === 1) ||
					(instruction === lookup && operand === 0)
				)
					continue;
				return true;
			}
			if (instruction === producer && operand === 0) continue;
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "defineProperty" ||
				operand !== 0
			)
				return true;
			const key = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1);
			if (fn.kernel.valueDefinitionKind(key) !== 1) return true;
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
			const opcode = fn.instructionOpcodeName(definition);
			const index = fn.instructionAttributes(definition).value;
			if (
				!["createNumber", "createI32", "createF64"].includes(opcode) ||
				typeof index !== "number" ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= 4294967295
			)
				return true;
		}
	}
	return false;
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
	if (units === undefined || units.length > 13) return undefined;
	const name = String.fromCharCode(...units);
	if (!isArrayIterationName(name)) return undefined;
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
 * holes are skipped through HasProperty (the find family reads every index), and
 * mapping and filtering create their default-species result before the loop. The result Array
 * stays unreachable from the callback, so CreateDataProperty is a plain define.
 * The caller admits the loop and callback inline together before expanding either graph.
 */
export function expandCoreArrayIterationCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreArrayIterationCall,
	guarded = true,
	singleton?: { readonly element: CoreValueId; readonly isArray: CoreValueId },
): {
	readonly callback: CoreInstructionId;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
} {
	const name = call.name;
	const filter = name === "filter";
	const reduce = name === "reduce" || name === "reduceRight";
	const reverse =
		name === "reduceRight" || name === "findLast" || name === "findLastIndex";
	const seedless = reduce && call.secondArgument === undefined;
	const flatMap = name === "flatMap";
	// filter carries its output index and reduce its accumulator beside the source index.
	const carries = filter || reduce;
	const finds =
		name === "find" ||
		name === "findIndex" ||
		name === "findLast" ||
		name === "findLastIndex";
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
	const fallback = guarded ? editor.createBlock() : undefined;
	const scalar = singleton === undefined ? undefined : editor.createBlock();
	const fast = editor.createBlock();
	const seedHeader = seedless ? editor.createBlock([{}]) : undefined;
	const seedPresent = seedless ? editor.createBlock() : undefined;
	const seedLoad = seedless ? editor.createBlock() : undefined;
	const seedAdvance = seedless ? editor.createBlock() : undefined;
	const seedEmpty = seedless ? editor.createBlock() : undefined;
	const header = editor.createBlock(carries || singleton !== undefined ? [{}, {}] : [{}]);
	const dispatch = singleton === undefined ? undefined : editor.createBlock();
	const present = finds ? undefined : editor.createBlock();
	const arrayElement = singleton === undefined ? undefined : editor.createBlock();
	const invoke = editor.createBlock(singleton === undefined ? [] : [{}]);
	const select = filter ? editor.createBlock() : undefined;
	const increment = editor.createBlock(carries ? [{}] : []);
	const normalExit = editor.createBlock();
	const earlyExit =
		name === "some" || name === "every" || finds ? editor.createBlock() : undefined;
	const join = editor.createBlock([{ representation: fn.valueRepresentation(result) }]);
	const blocks = [
		fallback,
		scalar,
		fast,
		seedHeader,
		seedPresent,
		seedLoad,
		seedAdvance,
		seedEmpty,
		header,
		dispatch,
		present,
		arrayElement,
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
	if (fallback !== undefined) {
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
	} else editor.removeInstruction(site);
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
	const undefinedValue = append(block, "createUndefined").outputs[0]!;
	if (fallback !== undefined) {
		jump(fallback, join, [result]);
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
	} else if (singleton !== undefined) branch(block, singleton.isArray, fast, scalar!);
	else jump(block, fast);
	if (scalar !== undefined) {
		const index = append(scalar, "createNumber", [], { value: 0 }).outputs[0]!;
		const length = append(scalar, "createNumber", [], { value: 1 }).outputs[0]!;
		jump(scalar, header, [index, length]);
	}
	const lengthKey = editor.appendStringConstants([
		[..."length"].map((unit) => unit.charCodeAt(0)),
	]);
	const arrayLength = append(fast, "loadPropertyStatic", [call.receiver], {
		stringIndex: lengthKey,
	}).outputs[0]!;
	const zero = append(fast, "createNumber", [], { value: 0 }).outputs[0]!;
	const one = append(singleton === undefined ? fast : block, "createNumber", [], {
		value: 1,
	}).outputs[0]!;
	// With the default species, map's ArraySpeciesCreate(O, len) is ArrayCreate(len): the
	// result has its final length before the first define, and the runtime reserves it.
	const created =
		name === "map"
			? append(fast, "construct", [
					append(fast, "loadIntrinsic", [], { intrinsic: "Array" }).outputs[0]!,
					arrayLength,
				]).outputs[0]!
			: filter || flatMap
				? append(fast, "createArray", [], { length: 0 }).outputs[0]!
				: undefined;
	const initialIndex = reverse
		? append(fast, "binary", [arrayLength, one], { operator: "-" }).outputs[0]!
		: zero;
	if (seedHeader !== undefined) {
		jump(fast, seedHeader, [initialIndex]);
		const index = fn.kernel.blockParameterValue(
			fn.kernel.blockParameterStart(seedHeader),
		);
		const withinLength = append(
			seedHeader,
			"binary",
			reverse ? [index, zero] : [index, arrayLength],
			{
				operator: reverse ? ">=" : "<",
			},
		).outputs[0]!;
		branch(seedHeader, withinLength, seedPresent!, seedEmpty!);
		const exists = append(seedPresent!, "binary", [index, call.receiver], {
			operator: "in",
		}).outputs[0]!;
		branch(seedPresent!, exists, seedLoad!, seedAdvance!);
		const seed = append(seedLoad!, "loadProperty", [call.receiver, index]).outputs[0]!;
		const following = append(seedLoad!, "binary", [index, one], {
			operator: reverse ? "-" : "+",
		}).outputs[0]!;
		jump(seedLoad!, header, [following, seed]);
		const next = append(seedAdvance!, "binary", [index, one], {
			operator: reverse ? "-" : "+",
		}).outputs[0]!;
		jump(seedAdvance!, seedHeader, [next]);
		const errorConstructor = append(seedEmpty!, "loadIntrinsic", [], {
			intrinsic: "TypeError",
		}).outputs[0]!;
		const messageIndex = editor.appendStringConstants([
			[..."Reduce of empty array with no initial value"].map((unit) =>
				unit.charCodeAt(0),
			),
		]);
		const message = append(seedEmpty!, "createString", [], { stringIndex: messageIndex })
			.outputs[0]!;
		const error = append(seedEmpty!, "construct", [errorConstructor, message])
			.outputs[0]!;
		editor.setTerminator(seedEmpty!, { kind: "throw", value: error, sourcePosition });
	} else {
		if (reduce) instructionsIntroduced++;
		// Callback results are boxed, so an unboxed initial accumulator boxes here.
		const seed = reduce
			? editor.appendInstruction(fast, "move", [call.secondArgument!], {
					sourcePosition,
					outputRepresentations: ["boxed"],
				}).outputs[0]!
			: undefined;
		jump(
			fast,
			header,
			singleton !== undefined
				? [zero, arrayLength]
				: filter
					? [zero, zero]
					: seed !== undefined
						? [initialIndex, seed]
						: [initialIndex],
		);
	}
	const headerStart = fn.kernel.blockParameterStart(header);
	const index = fn.kernel.blockParameterValue(headerStart);
	const length =
		singleton === undefined
			? arrayLength
			: fn.kernel.blockParameterValue(headerStart + 1);
	const carried = carries ? [fn.kernel.blockParameterValue(headerStart + 1)] : [];
	const withinLength = append(
		header,
		"binary",
		reverse ? [index, zero] : [index, length],
		{ operator: reverse ? ">=" : "<" },
	).outputs[0]!;
	branch(header, withinLength, dispatch ?? present ?? invoke, normalExit);
	if (dispatch !== undefined) {
		branch(dispatch, singleton!.isArray, present ?? arrayElement!, invoke, [
			singleton!.element,
		]);
	}
	if (present !== undefined) {
		const exists = append(present, "binary", [index, call.receiver], { operator: "in" })
			.outputs[0]!;
		branch(present, exists, arrayElement ?? invoke, increment, carried);
	}
	if (arrayElement !== undefined) {
		const loaded = append(arrayElement, "loadProperty", [call.receiver, index])
			.outputs[0]!;
		jump(arrayElement, invoke, [loaded]);
	}
	const element =
		singleton === undefined
			? append(invoke, "loadProperty", [call.receiver, index]).outputs[0]!
			: fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(invoke));
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
		case "findLast":
		case "findLastIndex":
			branch(invoke, returned, earlyExit!, increment);
			break;
		case "every":
			branch(invoke, returned, increment, earlyExit!);
			break;
		case "forEach":
			jump(invoke, increment);
			break;
		case "map":
			append(invoke, "defineProperty", [created!, index, returned], {
				enumerable: true,
				privateArrayStore: "indexed",
			});
			jump(invoke, increment);
			break;
		case "filter": {
			branch(invoke, returned, select!, increment, carried);
			append(select!, "defineProperty", [created!, carried[0]!, element], {
				enumerable: true,
				privateArrayStore: "append",
			});
			const following = append(select!, "binary", [carried[0]!, one], { operator: "+" })
				.outputs[0]!;
			jump(select!, increment, [following]);
			break;
		}
		case "flatMap": {
			const appendMapped = append(invoke, "loadIntrinsic", [], {
				intrinsic: "__arrayFlatMapAppend",
			}).outputs[0]!;
			append(invoke, "call", [appendMapped, undefinedValue, created!, returned]);
			jump(invoke, increment);
			break;
		}
		case "reduce":
		case "reduceRight":
			jump(invoke, increment, [returned]);
			break;
	}
	const next = append(increment, "binary", [index, one], {
		operator: reverse ? "-" : "+",
	}).outputs[0]!;
	jump(
		increment,
		header,
		singleton !== undefined
			? [next, length]
			: carries
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
		case "findLast":
			jump(normalExit, join, [undefinedValue]);
			jump(earlyExit!, join, [element]);
			break;
		case "findIndex":
		case "findLastIndex":
			jump(normalExit, join, [
				append(normalExit, "createNumber", [], { value: -1 }).outputs[0]!,
			]);
			jump(earlyExit!, join, [index]);
			break;
		case "reduce":
		case "reduceRight":
			jump(normalExit, join, [carried[0]!]);
			break;
		case "forEach":
			jump(normalExit, join, [undefinedValue]);
			break;
		case "map":
		case "filter":
		case "flatMap":
			jump(normalExit, join, [created!]);
			break;
	}
	return {
		callback: callback.instruction,
		instructionsIntroduced,
		blocksIntroduced: blocks.length,
	};
}
