import { verifyBuiltinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall, WorldFacts } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_OBJECT,
	compilerValueKindCannotBeHeldWeakly,
} from "../shared/compiler-value-kinds.ts";
import { knownOperationCallProves } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import { coreGuardableCall, splitGuardedCall } from "./core-function-prototype-call.ts";
import { CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreValueControlFlowUseMask } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreInstructionId } from "./core-ir.ts";
import { literalDefinition } from "./core-literal-graph.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/** Exact namespace call operands after identity and semantic obligations are discharged. */
export function knownObjectAssignOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	world?: WorldFacts,
) {
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
		known?.identity.kind !== "known" ||
		known.semantics.kind !== "known" ||
		!knownOperationCallProves(known, "Object.assign") ||
		known.identity.proof.obligations.length !== 0 ||
		known.semantics.proof.obligations.length !== 0
	)
		return undefined;
	if (
		!compilerFactIsWorldInvariant(known.identity) ||
		!compilerFactIsWorldInvariant(known.semantics)
	) {
		if (world?.primordialPolicy !== "mutable" || world.realms) return undefined;
		try {
			verifyBuiltinWorldAssumptions(attributes.worldAssumptions, "Object.assign", world);
		} catch {
			return undefined;
		}
	}
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
	return { target, source };
}

/**
 * A direct global Object.assign lookup whose captured callee is the intrinsic
 * while the monotonic primordial-bindings epoch still has its initial value.
 * A dynamic with lookup joins its result with the global fallback, so it does not
 * match this direct receiver even inside a strict closure.
 */
export function guardableObjectAssignOperands(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
) {
	if (
		!fn.metadata.strict ||
		!coreGuardableCall(fn, instruction) ||
		fn.kernel.instructionOperandCount(instruction) !== 4
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const callee = literalDefinition(fn, fn.kernel.operandAt(start));
	const receiver = fn.kernel.operandAt(start + 1);
	const namespace = literalDefinition(fn, receiver);
	if (
		callee === undefined ||
		namespace === undefined ||
		fn.instructionOpcodeName(callee) !== "loadPropertyStatic" ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(callee)) !== receiver ||
		program.stringConstantText(fn.instructionAttributes(callee).stringIndex as number) !==
			"assign" ||
		fn.instructionOpcodeName(namespace) !== "loadGlobalProperty" ||
		fn.instructionAttributes(namespace)[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE] ===
			true ||
		program.stringConstantText(
			fn.instructionAttributes(namespace).nameStringIndex as number,
		) !== "Object"
	)
		return undefined;
	return {
		target: fn.kernel.operandAt(start + 2),
		source: fn.kernel.operandAt(start + 3),
	};
}

function literalAssign(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operands = knownObjectAssignOperands(fn, instruction),
) {
	if (operands === undefined) return undefined;
	const { target, source } = operands;
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
		fn.kernel.useOperand(use) !==
			(fn.instructionOpcodeName(instruction) === "call" ? 3 : 2)
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
	return { target, source, keys, values, allocation };
}

export const lowerLiteralObjectAssign: CoreFunctionPass = {
	name: "lower-literal-object-assign",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown", "call"],
	admission: {
		predicate: "strict intrinsic Object.assign with a private shaped source",
		hasOpportunity({ program, function: functionId, compilationContext }) {
			const world = compilationContext.facts.world;
			const fn = program.function(functionId);
			return (
				!world.realms &&
				fn.metadata.strict &&
				[...fn.instructionIds()].some(
					(instruction) =>
						literalAssign(
							fn,
							instruction,
							knownObjectAssignOperands(fn, instruction, world) ??
								(world.primordialPolicy === "mutable"
									? guardableObjectAssignOperands(program, fn, instruction)
									: undefined),
						) !== undefined,
				)
			);
		},
	},
	candidates: {
		dependencies: ["body", "calls", "facts"],
		opcodes: ["callKnown", "call"],
		matches(fn, instruction) {
			return (
				fn.instructionOpcodeName(instruction) === "call" ||
				fn.instructionAttributes(instruction).operation === "Object.assign"
			);
		},
	},
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "calls", "facts", "memoryEffects"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const fn = context.program.function(context.item.function);
		const world = context.compilationContext.facts.world;
		// Object.assign always uses throwing Set; ordinary stores inherit caller strictness.
		if (!fn.metadata.strict || world.realms) return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let edgeUses: Uint8Array | undefined;
		for (const instruction of context.instructions()) {
			const known = knownObjectAssignOperands(fn, instruction, world);
			const guarded = known === undefined && world.primordialPolicy === "mutable";
			const plan = literalAssign(
				fn,
				instruction,
				guarded ? guardableObjectAssignOperands(context.program, fn, instruction) : known,
			);
			if (
				plan === undefined ||
				context.remainingEdits < plan.keys.length + (guarded ? 20 : 2) ||
				kinds.kindMask(plan.target) !== COMPILER_VALUE_KIND_OBJECT ||
				(guarded &&
					fn.instructionBlock(plan.allocation) !== fn.instructionBlock(instruction)) ||
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
			if (guarded) {
				const split = splitGuardedCall(fn, editor, instruction);
				const holds = split.append(block, "guardSemanticEpoch", [], {
					family: "primordial-bindings",
				});
				const direct = split.test(holds);
				// Only the retained call observes the private source object. All field
				// evaluations stay before the branch, including effects that revoke it.
				editor.moveInstruction(plan.allocation, split.fallback, instruction);
				for (const [index, stringIndex] of plan.keys.entries())
					editor.appendInstruction(
						direct,
						"storePropertyStatic",
						[plan.target, plan.values[index]!],
						{
							outputCount: 0,
							attributes: { stringIndex },
							sourcePosition,
						},
					);
				split.finish(direct, plan.target);
				return editor.commit();
			}
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
