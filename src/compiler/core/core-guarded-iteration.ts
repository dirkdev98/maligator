import type { CoreEditor } from "./core-editor.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/*
 * Guarded iteration lets a loop drive a fused form of an iterator protocol whose
 * methods live on watched builtin prototypes, with mutable primordials. GetIterator
 * looks up @@iterator and `next` once, so the watched-methods protector checked there
 * proves both for the whole loop; otherwise the original protocol runs as the twin.
 * Only IteratorClose looks a method up later, so a fused close checks the protector
 * again and, once it failed, rebuilds the iterator the loop would hold and closes it.
 */

/** Edits counted for the transform report. */
export interface CoreGuardedIterationEdits {
	instructions: number;
	blocks: number;
}

export interface CoreGuardedIterationEntry {
	/** Holds the rest of the entry block and its terminator; both paths meet here. */
	readonly join: CoreBlockId;
	/** The twin's iterator record; undefined on the fused path. */
	readonly iterator: CoreValueId;
	readonly next: CoreValueId;
	readonly fused: CoreValueId;
}

export function emitGuardedIterationInstruction(
	editor: CoreEditor,
	edits: CoreGuardedIterationEdits,
	block: CoreBlockId,
	opcode: string,
	inputs: ReadonlyArray<CoreValueId>,
	sourcePosition: number | undefined,
	attributes: Readonly<Record<string, CoreAttributeValue>> = {},
	representation?: CoreRepresentation,
): CoreValueId {
	edits.instructions++;
	return editor.appendInstruction(block, opcode, inputs, {
		attributes,
		sourcePosition,
		...(representation === undefined ? {} : { outputRepresentations: [representation] }),
	}).outputs[0]!;
}

function blockHandler(fn: CoreFunctionStore, block: CoreBlockId) {
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler === undefined) return undefined;
	const start = fn.kernel.blockHandlerArgumentStart(block);
	return {
		block: handler,
		arguments: Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		),
	};
}

function createBlocks(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	edits: CoreGuardedIterationEdits,
	like: CoreBlockId,
	parameters: ReadonlyArray<ReadonlyArray<{ representation: CoreRepresentation }>>,
): Array<CoreBlockId> {
	const handler = blockHandler(fn, like);
	return parameters.map((specs) => {
		const created = editor.createBlock(specs);
		edits.blocks++;
		if (handler !== undefined)
			editor.setHandler(created, handler.block, handler.arguments);
		return created;
	});
}

/** Whether the entry block's handler can still be reached once the block splits at `first`. */
export function guardedIterationEntrySplittable(
	fn: CoreFunctionStore,
	first: CoreInstructionId,
): boolean {
	const handler = blockHandler(fn, fn.instructionBlock(first));
	if (handler === undefined) return true;
	const tail = new Set<CoreInstructionId>();
	for (
		let next: CoreInstructionId | undefined = first;
		next !== undefined;
		next = fn.instructionNext(next)
	)
		tail.add(next);
	return handler.arguments.every(
		(value) =>
			fn.kernel.valueDefinitionKind(value) !== 1 ||
			!tail.has(coreInstructionId(fn.kernel.valueDefinitionOwner(value))),
	);
}

/*
 * Splits the block of `twin`, whose last instruction is the GetIterator, in front of
 * `twin`: the guard enters the join directly with an absent record, the twin creates
 * the record first. Uses of the record move to the join's parameters.
 */
export function splitGuardedIterationEntry(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	edits: CoreGuardedIterationEdits,
	twin: ReadonlyArray<CoreInstructionId>,
): CoreGuardedIterationEntry {
	const get = twin[twin.length - 1]!;
	const block = fn.instructionBlock(get);
	const sourcePosition = fn.instructionSourcePosition(twin[0]!);
	const terminator = fn.blockTerminator(block);
	const iterator = fn.kernel.resultAt(fn.kernel.instructionResultStart(get));
	const next = fn.kernel.resultAt(fn.kernel.instructionResultStart(get) + 1);
	const remainder: Array<CoreInstructionId> = [];
	for (
		let following = fn.instructionNext(get);
		following !== undefined && following !== terminator;
		following = fn.instructionNext(following)
	)
		remainder.push(following);
	const iteratorRepresentation = fn.valueRepresentation(iterator);
	const nextRepresentation = fn.valueRepresentation(next);
	const [twinEntry, join] = createBlocks(fn, editor, edits, block, [
		[],
		[
			{ representation: iteratorRepresentation },
			{ representation: nextRepresentation },
			{ representation: "boolean" },
		],
	]);
	for (const instruction of twin) editor.moveInstruction(instruction, twinEntry!);
	for (const instruction of remainder) editor.moveInstruction(instruction, join!);
	editor.setTerminator(join!, {
		...coreTerminatorInput(fn, terminator),
		sourcePosition: fn.instructionSourcePosition(terminator),
	});
	editor.removeInstruction(terminator);
	const start = fn.kernel.blockParameterStart(join!);
	const [joinedIterator, joinedNext, fused] = [0, 1, 2].map((index) =>
		fn.kernel.blockParameterValue(start + index),
	);
	editor.replaceValueUses(iterator, joinedIterator!);
	editor.replaceValueUses(next, joinedNext!);
	const emit = (
		at: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		attributes: Readonly<Record<string, CoreAttributeValue>>,
		representation: CoreRepresentation,
	) =>
		emitGuardedIterationInstruction(
			editor,
			edits,
			at,
			opcode,
			inputs,
			sourcePosition,
			attributes,
			representation,
		);
	editor.setTerminator(twinEntry!, {
		kind: "jump",
		edge: {
			block: join!,
			arguments: [
				iterator,
				next,
				emit(twinEntry!, "createBoolean", [], { value: false }, "boolean"),
			],
		},
		sourcePosition,
	});
	const holds = emit(
		block,
		"guardSemanticEpoch",
		[],
		{ family: "watched-methods" },
		"boolean",
	);
	const absent = emit(block, "createUndefined", [], {}, "boxed");
	const absentAs = (representation: CoreRepresentation) =>
		representation === "boxed"
			? absent
			: emit(block, "move", [absent], {}, representation);
	editor.setTerminator(block, {
		kind: "branch",
		condition: holds,
		consequent: {
			block: join!,
			arguments: [
				absentAs(iteratorRepresentation),
				absentAs(nextRepresentation),
				emit(block, "createBoolean", [], { value: true }, "boolean"),
			],
		},
		alternate: { block: twinEntry!, arguments: [] },
		sourcePosition,
	});
	return { join: join!, iterator: joinedIterator!, next: joinedNext!, fused: fused! };
}

/** The iterator a fused loop would hold, recreated in `block`. */
export interface CoreRebuiltIterator {
	readonly iterator: CoreValueId;
	/** The realm's own `next` of that iterator. */
	readonly next: CoreValueId;
	/** How many values the loop has consumed, as an f64. */
	readonly consumed: CoreValueId;
}

/*
 * Each close of the twin's record keeps closing it on the twin path. The fused path
 * closes nothing while the protector holds; otherwise `rebuild` recreates the
 * iterator, which the realm's own `next` advances past the consumed values before
 * the original close runs on it.
 */
export function guardIterationCloses(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	edits: CoreGuardedIterationEdits,
	closes: ReadonlyArray<CoreInstructionId>,
	fused: CoreValueId,
	rebuild: (block: CoreBlockId) => CoreRebuiltIterator,
): void {
	for (const close of closes) {
		const block = fn.instructionBlock(close);
		const terminator = fn.blockTerminator(block);
		const sourcePosition = fn.instructionSourcePosition(close);
		const emit = (
			at: CoreBlockId,
			opcode: string,
			inputs: ReadonlyArray<CoreValueId>,
			attributes: Readonly<Record<string, CoreAttributeValue>> = {},
			representation?: CoreRepresentation,
		) =>
			emitGuardedIterationInstruction(
				editor,
				edits,
				at,
				opcode,
				inputs,
				sourcePosition,
				attributes,
				representation,
			);
		const tail: Array<CoreInstructionId> = [];
		for (
			let next = fn.instructionNext(close);
			next !== undefined && next !== terminator;
			next = fn.instructionNext(next)
		)
			tail.push(next);
		const [twinClose, fusedClose, rebuilt, advance, step, closeRebuilt, after] =
			createBlocks(fn, editor, edits, block, [
				[],
				[],
				[],
				[{ representation: "f64" }],
				[],
				[],
				[],
			]);
		for (const instruction of tail) editor.moveInstruction(instruction, after!);
		editor.setTerminator(after!, {
			...coreTerminatorInput(fn, terminator),
			sourcePosition: fn.instructionSourcePosition(terminator),
		});
		editor.removeInstruction(terminator);
		const attributes = fn.instructionAttributes(close);
		editor.moveInstruction(close, twinClose!);
		const jump = (
			from: CoreBlockId,
			to: CoreBlockId,
			arguments_: Array<CoreValueId> = [],
		) =>
			editor.setTerminator(from, {
				kind: "jump",
				edge: { block: to, arguments: arguments_ },
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
		jump(twinClose!, after!);
		branch(block, fused, fusedClose!, twinClose!);
		const intact = emit(
			fusedClose!,
			"guardSemanticEpoch",
			[],
			{ family: "watched-methods" },
			"boolean",
		);
		branch(fusedClose!, intact, after!, rebuilt!);
		const record = rebuild(rebuilt!);
		const one = emit(rebuilt!, "createNumber", [], { value: 1 }, "f64");
		jump(rebuilt!, advance!, [emit(rebuilt!, "createNumber", [], { value: 0 }, "f64")]);
		const advanced = fn.kernel.blockParameterValue(
			fn.kernel.blockParameterStart(advance!),
		);
		branch(
			advance!,
			emit(advance!, "binary", [advanced, record.consumed], { operator: "<" }, "boolean"),
			step!,
			closeRebuilt!,
		);
		edits.instructions++;
		editor.appendInstruction(step!, "iteratorStep", [record.iterator, record.next], {
			outputCount: 2,
			sourcePosition,
		});
		jump(step!, advance!, [
			emit(step!, "binary", [advanced, one], { operator: "+" }, "f64"),
		]);
		edits.instructions++;
		editor.appendInstruction(closeRebuilt!, "iteratorClose", [record.iterator], {
			outputCount: 0,
			attributes,
			sourcePosition,
		});
		jump(closeRebuilt!, after!);
	}
}
