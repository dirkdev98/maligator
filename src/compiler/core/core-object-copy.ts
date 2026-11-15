import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import { splitGuardedCall } from "./core-function-prototype-call.ts";
import type { CoreInstructionId } from "./core-ir.ts";
import { literalDefinition } from "./core-literal-graph.ts";
import {
	guardableObjectAssignOperands,
	knownObjectAssignOperands,
} from "./core-literal-object-assign.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

function freshAssign(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operands: ReturnType<typeof knownObjectAssignOperands>,
) {
	if (operands === undefined) return undefined;
	const allocation = literalDefinition(fn, operands.target);
	if (
		allocation === undefined ||
		fn.instructionOpcodeName(allocation) !== "createObject" ||
		fn.kernel.instructionOperandCount(allocation) !== 0 ||
		fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)) !==
			operands.target ||
		fn.instructionBlock(allocation) !== fn.instructionBlock(instruction) ||
		fn.kernel.valueHandlerUseCount(operands.target) !== 0
	)
		return undefined;
	const after = new Set<CoreInstructionId>();
	for (
		let next = fn.instructionNext(instruction);
		next !== undefined;
		next = fn.instructionNext(next)
	) {
		if (after.size >= 4096) return undefined;
		after.add(next);
	}
	for (
		let use = fn.kernel.valueFirstUse(operands.target);
		use >= 0;
		use = fn.kernel.useNext(use)
	) {
		const user = fn.kernel.useInstruction(use);
		if (
			user === instruction
				? fn.kernel.useOperand(use) !==
					(fn.instructionOpcodeName(instruction) === "call" ? 2 : 1)
				: !after.has(user)
		)
			return undefined;
	}
	return { ...operands, allocation };
}

/** Keep copying getters inside the allocating instruction's safepoint contract. */
export const lowerFreshObjectCopies: CoreFunctionPass = {
	name: "lower-fresh-object-copies",
	stage: "finalize",
	requiredFunctionOpcodesAny: ["mergeDataProperties", "callKnown", "call"],
	candidates: {
		dependencies: ["body"],
		opcodes: ["createObject", "callKnown", "call"],
	},
	requiredAnalyses: [],
	wakesOn: ["body", "cfg"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		if (context.remainingEdits < 2) return undefined;
		const fn = context.program.function(context.item.function);
		const world = context.compilationContext.facts.world;
		for (const allocation of context.instructions()) {
			if (fn.instructionOpcodeName(allocation) === "call") {
				if (
					world.primordialPolicy !== "mutable" ||
					world.realms ||
					context.remainingEdits < 20
				)
					continue;
				const fresh = freshAssign(
					fn,
					allocation,
					guardableObjectAssignOperands(context.program, fn, allocation),
				);
				if (fresh === undefined || fn.kernel.valueUseCount(fresh.target) !== 1) continue;
				const editor = CoreEditor.open(context.program, fn.id);
				const block = fn.instructionBlock(allocation);
				const split = splitGuardedCall(fn, editor, allocation);
				const holds = split.append(block, "guardSemanticEpoch", [], {
					family: "primordial-bindings",
				});
				const direct = split.test(holds);
				editor.moveInstruction(fresh.allocation, split.fallback, allocation);
				const copy = editor.appendInstruction(
					direct,
					"copyDataProperties",
					[fresh.source],
					{
						attributes: { copyMode: "assign" },
						sourcePosition: fn.instructionSourcePosition(allocation),
					},
				).outputs[0]!;
				split.finish(direct, copy);
				return editor.commit();
			}
			if (fn.instructionOpcodeName(allocation) === "callKnown") {
				if (world.realms || context.remainingEdits < 3) continue;
				const fresh = freshAssign(
					fn,
					allocation,
					knownObjectAssignOperands(fn, allocation, world),
				);
				if (
					fresh === undefined ||
					context.remainingEdits < fn.kernel.valueUseCount(fresh.target) + 3
				)
					continue;
				const proof = fn.instructionEffectRefinement(allocation)?.proof;
				const editor = CoreEditor.open(context.program, fn.id);
				editor.replaceInstruction(allocation, "copyDataProperties", [fresh.source], {
					attributes: { copyMode: "assign" },
					sourcePosition: fn.instructionSourcePosition(allocation),
				});
				removeUnsharedProof(editor, fn, proof);
				editor.replaceValueUses(
					fresh.target,
					fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
				);
				editor.removeInstruction(fresh.allocation);
				return editor.commit();
			}
			const attributes = fn.instructionAttributes(allocation);
			if (
				typeof attributes.slotReserve !== "number" ||
				fn.kernel.instructionOperandCount(allocation) !== 1
			)
				continue;
			const merge = fn.instructionNext(allocation);
			if (
				merge === undefined ||
				fn.instructionKind(merge) !== "operation" ||
				fn.instructionOpcodeName(merge) !== "mergeDataProperties"
			)
				continue;
			const source = fn.kernel.operandAt(fn.kernel.instructionOperandStart(allocation));
			const target = fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation));
			const start = fn.kernel.instructionOperandStart(merge);
			if (
				fn.kernel.operandAt(start) !== target ||
				fn.kernel.operandAt(start + 1) !== source
			)
				continue;
			const editor = CoreEditor.open(context.program, fn.id);
			editor.replaceInstruction(allocation, "copyDataProperties", [source], {
				attributes: { copyMode: "spread", slotReserve: attributes.slotReserve },
				sourcePosition: fn.instructionSourcePosition(merge),
			});
			editor.removeInstruction(merge);
			return editor.commit();
		}
		return undefined;
	},
};
