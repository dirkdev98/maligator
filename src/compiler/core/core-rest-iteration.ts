import {
	compilerFactIsWorldInvariant,
	unconfinedDynamicCode,
} from "../shared/compiler-facts.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import {
	emitGuardedIterationInstruction,
	guardedIterationEntrySplittable,
	guardIterationCloses,
	splitGuardedIterationEntry,
} from "./core-guarded-iteration.ts";
import type { CoreGuardedIterationEdits } from "./core-guarded-iteration.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const MAX_NUMERIC_REST_ELEMENTS = 4;

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	position: number,
) {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + position);
}

function result(fn: CoreFunctionStore, instruction: CoreInstructionId, position = 0) {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + position);
}

function uses(fn: CoreFunctionStore, value: CoreValueId) {
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
	const found: Array<{ instruction: CoreInstructionId; position: number }> = [];
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = fn.kernel.useInstruction(use);
		if (fn.instructionKind(instruction) !== "operation") return undefined;
		found.push({ instruction, position: fn.kernel.useOperand(use) });
	}
	return found;
}

function restIteration(program: CoreProgram, fn: CoreFunctionStore) {
	const allocations = [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "createRestArguments",
	);
	if (allocations.length !== 1) return undefined;
	const allocation = allocations[0]!;
	const entry = [...fn.bodyInstructionIds(fn.entry)];
	const allocationPosition = entry.indexOf(allocation);
	if (
		allocationPosition < 0 ||
		entry
			.slice(0, allocationPosition)
			.some(
				(instruction) =>
					fn.instructionOpcodeName(instruction) !== "createRestArgumentsState",
			)
	)
		return undefined;
	const rest = result(fn, allocation);
	const restUses = uses(fn, rest);
	if (restUses?.length !== 1) return undefined;
	const initialize = restUses[0]!.instruction;
	if (
		restUses[0]!.position !== 0 ||
		fn.instructionOpcodeName(initialize) !== "getIterator" ||
		fn.kernel.instructionResultCount(initialize) !== 2
	)
		return undefined;
	const iterator = result(fn, initialize);
	const next = result(fn, initialize, 1);
	const iteratorUses = uses(fn, iterator);
	const nextUses = uses(fn, next);
	if (iteratorUses === undefined || iteratorUses.length > 33 || nextUses?.length !== 1)
		return undefined;
	const step = nextUses[0]!.instruction;
	if (
		nextUses[0]!.position !== 1 ||
		fn.instructionOpcodeName(step) !== "iteratorStep" ||
		operand(fn, step, 0) !== iterator ||
		fn.kernel.instructionResultCount(step) !== 2 ||
		iteratorUses.some(
			(use) =>
				use.position !== 0 ||
				(use.instruction !== step &&
					fn.instructionOpcodeName(use.instruction) !== "iteratorClose"),
		)
	)
		return undefined;
	const control = buildCoreControlFlow(program, fn.id, { exceptions: true });
	const header = fn.instructionBlock(step);
	const loop = control.loops.find((candidate) => candidate.header === header);
	if (
		loop === undefined ||
		[...fn.bodyInstructionIds(header)][0] !== step ||
		control.irreducibleCycles.some((cycle) => cycle.blocks.has(header))
	)
		return undefined;
	const incoming = (control.predecessors[header] ?? []).map((edge) => ({
		from: control.edges.from(edge),
		kind: control.edges.kind(edge),
		arguments: control.edges.arguments(edge),
	}));
	const external = incoming.filter((edge) => !loop.blocks.has(edge.from));
	if (
		external.length !== 1 ||
		incoming.some((edge) => edge.kind !== "ordinary") ||
		new Set(incoming.map((edge) => edge.from)).size !== incoming.length
	)
		return undefined;
	const done = result(fn, step, 1);
	const exit = coreTerminatorInput(fn, fn.blockTerminator(header));
	if (
		exit.kind !== "branch" ||
		exit.condition !== done ||
		loop.blocks.has(exit.consequent.block) ||
		!loop.blocks.has(exit.alternate.block)
	)
		return undefined;
	const body = exit.alternate.block;
	const bodyIncoming = control.predecessors[body] ?? [];
	const valueUses = uses(fn, result(fn, step));
	if (
		bodyIncoming.length !== 1 ||
		control.edges.from(bodyIncoming[0]!) !== header ||
		control.edges.kind(bodyIncoming[0]!) !== "ordinary" ||
		valueUses === undefined ||
		valueUses.length === 0 ||
		valueUses.some(
			(use) => !control.dominates(body, fn.instructionBlock(use.instruction)),
		) ||
		[...loop.latches].some((latch) => !control.dominates(body, latch))
	)
		return undefined;
	const initializationBlock = fn.instructionBlock(initialize);
	if (loop.blocks.has(initializationBlock)) return undefined;
	const seen = new Set<number>();
	let block = initializationBlock;
	while (block !== external[0]!.from) {
		if (seen.has(block)) return undefined;
		seen.add(block);
		const outgoing = control.successors[block] ?? [];
		if (outgoing.length !== 1 || control.edges.kind(outgoing[0]!) !== "ordinary")
			return undefined;
		block = control.edges.to(outgoing[0]!);
		const predecessors = control.predecessors[block] ?? [];
		if (predecessors.length !== 1 || control.edges.kind(predecessors[0]!) !== "ordinary")
			return undefined;
	}
	return {
		allocation,
		rest,
		initialize,
		step,
		value: result(fn, step),
		done,
		header,
		body,
		incoming,
		loop,
		closes: iteratorUses
			.filter((use) => use.instruction !== step)
			.map((use) => use.instruction),
	};
}

export const lowerPrivateRestIteration: CoreFunctionPass = {
	name: "lower-private-rest-iteration",
	stage: "memory",
	requiredFunctionOpcodesAny: ["createRestArguments"],
	requiredAnalyses: [],
	wakesOn: ["body", "cfg", "facts"],
	changes: { cfg: true, calls: true, facts: true, representations: true },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const fn = context.program.function(context.item.function);
		const { world, protectors } = context.compilationContext.facts;
		const guarded = world.primordialPolicy !== "locked" || world.realms;
		if (
			unconfinedDynamicCode(context.compilationContext.facts) ||
			fn.isAsync ||
			fn.isGenerator ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.mappedArguments ||
			(!guarded &&
				(!compilerFactIsWorldInvariant(protectors.get("primitive-methods")) ||
					!compilerFactIsWorldInvariant(protectors.get("array-elements"))))
		)
			return undefined;
		const plan = restIteration(context.program, fn);
		if (
			plan === undefined ||
			context.remainingEdits < 16 + plan.incoming.length + plan.closes.length
		)
			return undefined;
		if (guarded) {
			if (!guardedIterationEntrySplittable(fn, plan.initialize)) return undefined;
			const control = buildCoreControlFlow(context.program, fn.id, { exceptions: true });
			if (
				plan.closes.some(
					(close) => !control.dominates(plan.header, fn.instructionBlock(close)),
				)
			)
				return undefined;
			const reduction = numericRestReduction(fn, plan);
			const editor = CoreEditor.open(context.program, fn.id);
			lowerGuardedRestIteration(fn, editor, plan);
			if (reduction !== undefined && context.remainingEdits >= 96)
				guardNumericRestReduction(fn, editor, reduction);
			return editor.commit();
		}
		const editor = CoreEditor.open(context.program, fn.id);
		const sourcePosition = fn.instructionSourcePosition(plan.step);
		const insert = (
			block: typeof plan.header,
			before: CoreInstructionId,
			opcode: string,
			inputs: ReadonlyArray<CoreValueId>,
			attributes = {},
		) =>
			editor.insertInstruction(block, before, opcode, inputs, {
				attributes,
				sourcePosition,
			}).outputs[0]!;
		const initializeBlock = fn.instructionBlock(plan.initialize);
		const zero = insert(initializeBlock, plan.initialize, "createNumber", [], {
			value: 0,
		});
		const one = insert(initializeBlock, plan.initialize, "createNumber", [], {
			value: 1,
		});
		const lengthIndex =
			context.program.stringConstantSlot("length", "first") ??
			editor.appendStringConstants([Array.from("length", (unit) => unit.charCodeAt(0))]);
		const length = insert(
			initializeBlock,
			plan.initialize,
			"loadPropertyStatic",
			[plan.rest],
			{ stringIndex: lengthIndex },
		);
		const index = editor.appendBlockParameter(plan.header);
		const done = insert(plan.header, plan.step, "binary", [index, length], {
			operator: ">=",
		});
		const firstBodyInstruction =
			[...fn.bodyInstructionIds(plan.body)][0] ?? fn.blockTerminator(plan.body);
		const value = insert(plan.body, firstBodyInstruction, "loadProperty", [
			plan.rest,
			index,
		]);
		const following = insert(plan.body, firstBodyInstruction, "binary", [index, one], {
			operator: "+",
		});
		for (const edge of plan.incoming)
			editor.redirectEdge(edge.from, plan.header, {
				block: plan.header,
				arguments: [
					...edge.arguments,
					plan.loop.blocks.has(edge.from) ? following : zero,
				],
			});
		editor.replaceValueUses(plan.value, value);
		editor.replaceValueUses(plan.done, done);
		// Locked iterator prototypes make closing this private Array iterator unobservable.
		for (const instruction of [...plan.closes, plan.step, plan.initialize]) {
			const proof = fn.instructionEffectRefinement(instruction)?.proof;
			editor.removeInstruction(instruction);
			removeUnsharedProof(editor, fn, proof);
		}
		return editor.commit();
	},
};

interface NumericRestReduction {
	readonly operator:
		| "+"
		| "-"
		| "*"
		| "/"
		| "%"
		| "**"
		| "&"
		| "|"
		| "^"
		| "<<"
		| ">>"
		| ">>>";
	readonly initial: CoreValueId;
	readonly start: number;
	readonly sourcePosition: number | undefined;
}

function numericRestReduction(
	fn: CoreFunctionStore,
	plan: NonNullable<ReturnType<typeof restIteration>>,
): NumericRestReduction | undefined {
	const header = fn.kernel.blockParameterStart(plan.header);
	const body = [...fn.bodyInstructionIds(plan.body)];
	const operator =
		body.length === 1 ? fn.instructionAttributes(body[0]!).operator : undefined;
	switch (operator) {
		case "+":
		case "-":
		case "*":
		case "/":
		case "%":
		case "**":
		case "&":
		case "|":
		case "^":
		case "<<":
		case ">>":
		case ">>>":
			break;
		default:
			return undefined;
	}
	const start = fn.instructionAttributes(plan.allocation).startIndex;
	const incoming = plan.incoming.find((edge) => !plan.loop.blocks.has(edge.from));
	const bodyExit = coreTerminatorInput(fn, fn.blockTerminator(plan.body));
	const headerExit = coreTerminatorInput(fn, fn.blockTerminator(plan.header));
	if (
		typeof start !== "number" ||
		start < 0 ||
		start > 8 ||
		fn.kernel.blockParameterCount(plan.header) !== 1 ||
		plan.loop.blocks.size !== 2 ||
		body.length !== 1 ||
		fn.instructionOpcodeName(body[0]!) !== "binary" ||
		operand(fn, body[0]!, 0) !== fn.kernel.blockParameterValue(header) ||
		operand(fn, body[0]!, 1) !== plan.value ||
		bodyExit.kind !== "jump" ||
		bodyExit.edge.block !== plan.header ||
		bodyExit.edge.arguments.length !== 1 ||
		bodyExit.edge.arguments[0] !== result(fn, body[0]!) ||
		headerExit.kind !== "branch" ||
		incoming?.arguments.length !== 1 ||
		[...fn.bodyInstructionIds(fn.entry)].some(
			(instruction) => instruction !== plan.allocation,
		) ||
		[...fn.bodyInstructionIds(fn.instructionBlock(plan.initialize))].some(
			(instruction) => instruction !== plan.initialize,
		)
	)
		return undefined;
	const exit = coreTerminatorInput(fn, fn.blockTerminator(headerExit.consequent.block));
	if (
		exit.kind !== "return" ||
		exit.value !== fn.kernel.blockParameterValue(header) ||
		[...fn.bodyInstructionIds(headerExit.consequent.block)].length !== 0
	)
		return undefined;
	const initial = incoming.arguments[0]!;
	if (
		!Array.from({ length: Math.min(start, fn.parameterCount) }, (_, index) =>
			fn.kernel.functionParameter(index),
		).includes(initial)
	)
		return undefined;
	const entryExit = coreTerminatorInput(fn, fn.blockTerminator(fn.entry));
	const initializeExit = coreTerminatorInput(
		fn,
		fn.blockTerminator(fn.instructionBlock(plan.initialize)),
	);
	if (
		entryExit.kind !== "jump" ||
		entryExit.edge.block !== fn.instructionBlock(plan.initialize) ||
		initializeExit.kind !== "jump" ||
		initializeExit.edge.block !== plan.header ||
		[...fn.bodyInstructionIds(plan.header)].some(
			(instruction) => instruction !== plan.step,
		)
	)
		return undefined;
	return {
		operator,
		initial,
		start,
		sourcePosition: fn.instructionSourcePosition(body[0]!),
	};
}

/** A numeric reduction cannot call user code, so its guarded copy needs no iterator close. */
function guardNumericRestReduction(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	plan: NumericRestReduction,
): void {
	const sourcePosition = plan.sourcePosition;
	const fallback = editor.createBlock();
	for (const instruction of [...fn.bodyInstructionIds(fn.entry)])
		editor.moveInstruction(instruction, fallback);
	const terminator = fn.blockTerminator(fn.entry);
	editor.setTerminator(fallback, {
		...coreTerminatorInput(fn, terminator),
		sourcePosition,
	});
	editor.removeInstruction(terminator);
	const emit = (
		block: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		attributes: Readonly<Record<string, CoreAttributeValue>> = {},
		representation?: CoreRepresentation,
	) =>
		editor.appendInstruction(block, opcode, inputs, {
			attributes,
			sourcePosition,
			...(representation === undefined
				? {}
				: { outputRepresentations: [representation] }),
		}).outputs[0]!;
	let block = fn.entry;
	const test = (condition: CoreValueId) => {
		const next = editor.createBlock();
		editor.setTerminator(block, {
			kind: "branch",
			condition,
			consequent: { block: next, arguments: [] },
			alternate: { block: fallback, arguments: [] },
			sourcePosition,
		});
		block = next;
	};
	const count = emit(block, "loadArgumentCount", []);
	const limit = emit(block, "createNumber", [], {
		value: plan.start + MAX_NUMERIC_REST_ELEMENTS,
	});
	test(emit(block, "binary", [count, limit], { operator: "<=" }, "boolean"));
	test(emit(block, "guardSemanticEpoch", [], { family: "array-iteration" }, "boolean"));
	test(
		emit(
			block,
			"typeofCompare",
			[plan.initial],
			{ expected: "number", negated: false },
			"boolean",
		),
	);
	let total = emit(block, "unary", [plan.initial], { operator: "+" }, "f64");
	const returned = editor.createBlock([{ representation: "f64" }]);
	editor.setTerminator(returned, {
		kind: "return",
		value: fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(returned)),
		sourcePosition,
	});
	for (let index = plan.start; index < plan.start + MAX_NUMERIC_REST_ELEMENTS; index++) {
		const key = emit(block, "createNumber", [], { value: index });
		const done = emit(block, "binary", [count, key], { operator: "<=" }, "boolean");
		const more = editor.createBlock();
		editor.setTerminator(block, {
			kind: "branch",
			condition: done,
			consequent: { block: returned, arguments: [total] },
			alternate: { block: more, arguments: [] },
			sourcePosition,
		});
		block = more;
		const value = emit(block, "loadDynamicArgument", [key]);
		test(
			emit(
				block,
				"typeofCompare",
				[value],
				{ expected: "number", negated: false },
				"boolean",
			),
		);
		const number = emit(block, "unary", [value], { operator: "+" }, "f64");
		total = emit(block, "binary", [total, number], { operator: plan.operator }, "f64");
	}
	editor.setTerminator(block, {
		kind: "jump",
		edge: { block: returned, arguments: [total] },
		sourcePosition,
	});
}

/*
 * Mutable primordials keep the rest loop's protocol as the twin of a guarded
 * iteration (see core-guarded-iteration.ts): the array-iteration protector covers
 * %Array.prototype%[@@iterator] and %ArrayIteratorPrototype%.next, and the private,
 * dense rest array answers its length and every index below it from own data. Those
 * reads can use the retained incoming slice, allocating the Array only in the twin
 * or when a later IteratorClose needs to reconstruct the otherwise private iterator. The
 * header dispatches each step on the path the loop entered on; a fused close
 * rebuilds the Array iterator from the realm's own `values` and advances it past the
 * consumed elements.
 */
function lowerGuardedRestIteration(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	plan: NonNullable<ReturnType<typeof restIteration>>,
): void {
	const sourcePosition = fn.instructionSourcePosition(plan.step);
	const edits: CoreGuardedIterationEdits = { instructions: 0, blocks: 0 };
	const emit = (
		block: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		attributes: Readonly<Record<string, CoreAttributeValue>> = {},
		representation?: CoreRepresentation,
	) =>
		emitGuardedIterationInstruction(
			editor,
			edits,
			block,
			opcode,
			inputs,
			sourcePosition,
			attributes,
			representation,
		);
	const initializeBlock = fn.instructionBlock(plan.initialize);
	const startIndex = fn.instructionAttributes(plan.allocation).startIndex as number;
	const { join, fused } = splitGuardedIterationEntry(
		fn,
		editor,
		edits,
		[plan.initialize],
		"array-iteration",
	);
	editor.moveInstruction(
		plan.allocation,
		fn.instructionBlock(plan.initialize),
		plan.initialize,
	);
	const zero = emit(join, "createNumber", [], { value: 0 });
	const one = emit(join, "createNumber", [], { value: 1 });
	const offset = emit(join, "createNumber", [], { value: startIndex });
	const count = emit(join, "loadArgumentCount", []);

	// The header picks the step; both meet where the original header continued.
	const header = plan.header;
	const valueRepresentation = fn.valueRepresentation(plan.value);
	const doneRepresentation = fn.valueRepresentation(plan.done);
	const index = editor.appendBlockParameter(header);
	const handler = fn.kernel.blockHandlerBlock(header);
	const handlerStart = fn.kernel.blockHandlerArgumentStart(header);
	const handlerArguments = Array.from(
		{ length: fn.kernel.blockHandlerArgumentCount(header) },
		(_, position) => fn.kernel.handlerArgumentAt(handlerStart + position),
	);
	const create = (specs: ReadonlyArray<{ representation: CoreRepresentation }> = []) => {
		edits.blocks++;
		const created = editor.createBlock(specs);
		if (handler !== undefined) editor.setHandler(created, handler, handlerArguments);
		return created;
	};
	const fusedStep = create(),
		fusedElement = create(),
		twinStep = create(),
		stepped = create([
			{ representation: valueRepresentation },
			{ representation: doneRepresentation },
		]);
	const terminator = fn.blockTerminator(header);
	for (
		let next = fn.instructionNext(plan.step);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		editor.moveInstruction(next, stepped);
	editor.setTerminator(stepped, {
		...coreTerminatorInput(fn, terminator),
		sourcePosition: fn.instructionSourcePosition(terminator),
	});
	editor.removeInstruction(terminator);
	const steppedStart = fn.kernel.blockParameterStart(stepped);
	editor.replaceValueUses(plan.value, fn.kernel.blockParameterValue(steppedStart));
	editor.replaceValueUses(plan.done, fn.kernel.blockParameterValue(steppedStart + 1));
	editor.moveInstruction(plan.step, twinStep);
	const jump = (from: CoreBlockId, to: CoreBlockId, arguments_: Array<CoreValueId>) =>
		editor.setTerminator(from, {
			kind: "jump",
			edge: { block: to, arguments: arguments_ },
			sourcePosition,
		});
	jump(twinStep, stepped, [plan.value, plan.done]);
	editor.setTerminator(header, {
		kind: "branch",
		condition: fused,
		consequent: { block: fusedStep, arguments: [] },
		alternate: { block: twinStep, arguments: [] },
		sourcePosition,
	});
	const argumentIndex = emit(fusedStep, "binary", [index, offset], { operator: "+" });
	const finished = emit(
		fusedStep,
		"binary",
		[argumentIndex, count],
		{ operator: ">=" },
		doneRepresentation,
	);
	const absent = emit(fusedStep, "createUndefined", [], {}, "boxed");
	editor.setTerminator(fusedStep, {
		kind: "branch",
		condition: finished,
		consequent: {
			block: stepped,
			arguments: [
				valueRepresentation === "boxed"
					? absent
					: emit(fusedStep, "move", [absent], {}, valueRepresentation),
				finished,
			],
		},
		alternate: { block: fusedElement, arguments: [] },
		sourcePosition,
	});
	jump(fusedElement, stepped, [
		emit(fusedElement, "loadDynamicArgument", [argumentIndex], {}, valueRepresentation),
		finished,
	]);

	const firstBodyInstruction =
		[...fn.bodyInstructionIds(plan.body)][0] ?? fn.blockTerminator(plan.body);
	const following = editor.insertInstruction(
		plan.body,
		firstBodyInstruction,
		"binary",
		[index, one],
		{ attributes: { operator: "+" }, sourcePosition },
	).outputs[0]!;
	for (const edge of plan.incoming) {
		const inside = plan.loop.blocks.has(edge.from);
		editor.redirectEdge(edge.from === initializeBlock ? join : edge.from, header, {
			block: header,
			arguments: [...edge.arguments, inside ? following : zero],
		});
	}
	guardIterationCloses(
		fn,
		editor,
		edits,
		plan.closes,
		fused,
		"array-iteration",
		(block) => {
			const rest = emit(block, "createRestArguments", [], { startIndex });
			const values = emit(block, "loadIntrinsic", [], {
				intrinsic: "__arrayPrototypeValues",
			});
			edits.instructions++;
			const iterator = editor.appendInstruction(block, "call", [values, rest], {
				sourcePosition,
			}).outputs[0]!;
			return {
				iterator,
				next: emit(block, "loadIntrinsic", [], {
					intrinsic: "__arrayIteratorPrototypeNext",
				}),
				consumed: emit(block, "binary", [index, one], { operator: "+" }, "f64"),
			};
		},
	);
}
