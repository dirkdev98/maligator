import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_OBJECT,
	compilerValueKindCannotBeHeldWeakly,
} from "../shared/compiler-value-kinds.ts";
import { knownOperationCallProves } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import { coreValueControlFlowUseMask } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreInstructionId } from "./core-ir.ts";
import { literalDefinition } from "./core-literal-graph.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

function literalAssign(fn: CoreFunctionStore, instruction: CoreInstructionId) {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown" ||
		fn.kernel.instructionOperandCount(instruction) !== 3 ||
		fn.kernel.instructionResultCount(instruction) !== 1
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	const known = attributes.knownBuiltinCall as unknown as KnownBuiltinCall | undefined;
	if (
		attributes.operation !== "Object.assign" ||
		attributes.construct ||
		attributes.argumentMode !== undefined ||
		!knownOperationCallProves(known, "Object.assign") ||
		!compilerFactIsWorldInvariant(known?.identity) ||
		!compilerFactIsWorldInvariant(known?.semantics) ||
		known.identity.proof.obligations.length !== 0 ||
		known.semantics.proof.obligations.length !== 0
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const receiver = literalDefinition(fn, fn.kernel.operandAt(start));
	if (receiver === undefined) return undefined;
	const receiverOpcode = fn.instructionOpcodeName(receiver);
	const receiverAttributes = fn.instructionAttributes(receiver);
	if (
		!(receiverOpcode === "loadIntrinsic" && receiverAttributes.intrinsic === "Object") &&
		!(
			receiverOpcode === "loadPrimordial" &&
			getPrimordialCatalog().nodes[receiverAttributes.nodeIndex as number]?.[0] ===
				"Object"
		)
	)
		return undefined;
	const target = fn.kernel.operandAt(start + 1);
	const source = fn.kernel.operandAt(start + 2);
	const allocation = literalDefinition(fn, source);
	if (
		allocation === undefined ||
		fn.instructionOpcodeName(allocation) !== "createObjectShaped" ||
		fn.kernel.valueUseCount(source) !== 1 ||
		fn.kernel.valueHandlerUseCount(source) !== 0
	)
		return undefined;
	const use = fn.kernel.valueFirstUse(source);
	if (
		use < 0 ||
		fn.kernel.useInstruction(use) !== instruction ||
		fn.kernel.useOperand(use) !== 2
	)
		return undefined;
	const keys = fn.instructionAttributes(allocation)
		.keyStringIndices as ReadonlyArray<number>;
	if (keys.length > 16) return undefined;
	const values = Array.from(
		{ length: fn.kernel.instructionOperandCount(allocation) },
		(_, index) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(allocation) + index),
	);
	return { target, source, keys, values };
}

export const lowerLiteralObjectAssign: CoreFunctionPass = {
	name: "lower-literal-object-assign",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	admission: {
		predicate: "strict intrinsic Object.assign with a private shaped source",
		hasOpportunity({ program, function: functionId, compilationContext }) {
			const world = compilationContext.facts.world;
			const fn = program.function(functionId);
			return (
				world.primordialPolicy === "locked" &&
				!world.realms &&
				fn.metadata.strict &&
				[...fn.instructionIds()].some(
					(instruction) => literalAssign(fn, instruction) !== undefined,
				)
			);
		},
	},
	candidates: {
		dependencies: ["body", "calls", "facts"],
		opcodes: ["callKnown"],
		matches(fn, instruction) {
			return fn.instructionAttributes(instruction).operation === "Object.assign";
		},
	},
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "calls", "facts", "memoryEffects"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const fn = context.program.function(context.item.function);
		const world = context.compilationContext.facts.world;
		// Object.assign always uses throwing Set; ordinary stores inherit caller strictness.
		if (!fn.metadata.strict || world.primordialPolicy !== "locked" || world.realms)
			return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let edgeUses: Uint8Array | undefined;
		for (const instruction of context.instructions()) {
			const plan = literalAssign(fn, instruction);
			if (
				plan === undefined ||
				context.remainingEdits < plan.keys.length + 2 ||
				kinds.kindMask(plan.target) !== COMPILER_VALUE_KIND_OBJECT ||
				(edgeUses ??= coreValueControlFlowUseMask(fn))[plan.source] !== 0
			)
				continue;
			// Later setters can observe weak lifetimes after an earlier setter ignores a field.
			if (
				plan.values.some(
					(value) => !compilerValueKindCannotBeHeldWeakly(kinds.kindMask(value)),
				)
			)
				continue;
			const proof = fn.instructionEffectRefinement(instruction)?.proof;
			const editor = CoreEditor.open(context.program, fn.id);
			const block = fn.instructionBlock(instruction);
			const sourcePosition = fn.instructionSourcePosition(instruction);
			for (const [index, stringIndex] of plan.keys.entries())
				editor.insertInstruction(
					block,
					instruction,
					"storePropertyStatic",
					[plan.target, plan.values[index]!],
					{ outputCount: 0, attributes: { stringIndex }, sourcePosition },
				);
			editor.replaceInstruction(instruction, "move", [plan.target], { sourcePosition });
			removeUnsharedProof(editor, fn, proof);
			return editor.commit();
		}
		return undefined;
	},
};
