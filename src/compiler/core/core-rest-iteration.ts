import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

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
		...edge,
		arguments: [...edge.arguments],
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
		bodyIncoming[0]!.from !== header ||
		bodyIncoming[0]!.kind !== "ordinary" ||
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
		if (outgoing.length !== 1 || outgoing[0]!.kind !== "ordinary") return undefined;
		block = outgoing[0]!.to;
		const predecessors = control.predecessors[block] ?? [];
		if (predecessors.length !== 1 || predecessors[0]!.kind !== "ordinary")
			return undefined;
	}
	return {
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
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const fn = context.program.function(context.item.function);
		const { world, protectors } = context.compilationContext.facts;
		if (
			world.primordialPolicy !== "locked" ||
			world.eval !== "disabled" ||
			world.realms ||
			fn.isAsync ||
			fn.isGenerator ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.mappedArguments ||
			!compilerFactIsWorldInvariant(protectors.get("primitive-methods")) ||
			!compilerFactIsWorldInvariant(protectors.get("array-elements"))
		)
			return undefined;
		const plan = restIteration(context.program, fn);
		if (
			plan === undefined ||
			context.remainingEdits < 16 + plan.incoming.length + plan.closes.length
		)
			return undefined;
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
