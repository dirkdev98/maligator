import { knownBuiltinInvocationEffects } from "../shared/builtin-invocation-effects.ts";
import {
	builtinCallbackInvocation,
	builtinNormalResultKinds,
} from "../shared/builtin-registry.ts";
import { COMPILER_VALUE_KIND_OBJECT } from "../shared/compiler-value-kinds.ts";
import {
	EVERY_EFFECT_SUMMARY,
	effectSummariesEqual,
	joinEffectSummaries,
} from "../shared/effect-summary.ts";
import type { EffectSummary } from "../shared/effect-summary.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { PrimordialNode } from "../shared/primordial-catalog-types.ts";
import { primordialNode } from "../shared/primordial-catalog.ts";
import { coreBuiltinCallInput } from "./core-builtin-result-projections.ts";
import { CoreEditor } from "./core-editor.ts";
import { removeUnsharedProof } from "./core-effect-proof-edits.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_KNOWN_BUILTIN_EFFECT_FACT = "known-builtin-effects";
export const CORE_BUILTIN_CALLBACK_EFFECT_FACT = "builtin-callback-effects";

export interface CoreBuiltinCallbackInvocation {
	readonly instruction: CoreInstructionId;
	readonly callback: CoreValueId | undefined;
	readonly residualEffects: EffectSummary;
	readonly builtinEffects?: EffectSummary;
}

export function coreInstructionPrimordial(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): PrimordialNode | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	if (opcode === "loadPrimordial" && typeof attributes.nodeIndex === "number")
		return getPrimordialCatalog().nodes[attributes.nodeIndex];
	if (opcode === "loadIntrinsic" && typeof attributes.intrinsic === "string")
		return primordialNode(attributes.intrinsic);
	return undefined;
}

export function coreDirectPrimordial(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): PrimordialNode | undefined {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionOpcodeName(definition) !== "move")
		return coreInstructionPrimordial(fn, definition);
	return fn.kernel.instructionOperandCount(definition) === 0
		? undefined
		: coreDirectPrimordial(
				fn,
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition)),
				seen,
			);
}

export function coreBuiltinCallbackInvocation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreBuiltinCallbackInvocation | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (
		attributes.construct ||
		attributes.argumentMode !== undefined ||
		typeof attributes.operation !== "string"
	)
		return undefined;
	const callback = builtinCallbackInvocation(attributes.operation);
	if (callback?.residualEffects === undefined) return undefined;
	const input = coreBuiltinCallInput(fn, instruction, callback.argumentIndex + 1);
	if (input === undefined) return undefined;
	const canonical =
		input.input === undefined ? undefined : coreDirectPrimordial(fn, input.input)?.[0];
	return {
		instruction,
		callback: input.input,
		residualEffects: callback.residualEffects,
		...(canonical === undefined
			? {}
			: { builtinEffects: knownBuiltinInvocationEffects(canonical) }),
	};
}

export function coreBuiltinCallbackEffects(
	fn: CoreFunctionStore,
	invocation: CoreBuiltinCallbackInvocation,
	targets: CoreCallGraphIndex,
	effects: (functionId: CoreFunctionId) => EffectSummary | undefined,
): EffectSummary | undefined {
	let result = invocation.residualEffects;
	if (invocation.callback === undefined) return result;
	if (invocation.builtinEffects !== undefined)
		return joinEffectSummaries(result, invocation.builtinEffects);
	const callees = targets.targets(fn.id, invocation.callback);
	if (
		callees.opaque ||
		callees.anyScript ||
		(callees.functions.length === 0 && !callees.nonCallable)
	)
		return undefined;
	for (const target of callees.functions) {
		const summary = effects(target);
		if (summary === undefined) return undefined;
		// A callee's locals and this binding do not alias the caller's frame.
		result = joinEffectSummaries(result, {
			...summary,
			reads: summary.reads.filter(
				(domain) => domain !== "local-slot" && domain !== "activation-this",
			),
			writes: summary.writes.filter(
				(domain) => domain !== "local-slot" && domain !== "activation-this",
			),
		});
	}
	return result;
}

export function refineCoreBuiltinCallbackEffects(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
): ReadonlyArray<CoreChangeSet> {
	const changes: Array<CoreChangeSet> = [];
	const effects = (target: CoreFunctionId) => summaries.summary(target)?.effects;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const prior = fn.instructionEffectRefinement(instruction);
			if (
				prior !== undefined &&
				fn.fact(prior.proof).kind !== CORE_BUILTIN_CALLBACK_EFFECT_FACT
			)
				continue;
			const invocation = coreBuiltinCallbackInvocation(fn, instruction);
			const refined =
				invocation === undefined
					? undefined
					: coreBuiltinCallbackEffects(fn, invocation, summaries.targets, effects);
			if (
				refined === undefined ||
				refined.callsUserCode ||
				effectSummariesEqual(refined, EVERY_EFFECT_SUMMARY)
			) {
				if (prior === undefined) continue;
				editor ??= CoreEditor.open(program, functionId);
				editor.clearInstructionEffectRefinement(instruction);
				removeUnsharedProof(editor, fn, prior.proof);
				continue;
			}
			if (prior !== undefined && effectSummariesEqual(prior.effects, refined)) continue;
			editor ??= CoreEditor.open(program, functionId);
			if (prior !== undefined) {
				editor.clearInstructionEffectRefinement(instruction);
				removeUnsharedProof(editor, fn, prior.proof);
			}
			const operation = fn.instructionAttributes(instruction).operation as string;
			const proof = editor.addFact({
				kind: CORE_BUILTIN_CALLBACK_EFFECT_FACT,
				value: operation,
				claims: [{ kind: "effect", instruction, effects: refined }],
				validity: { kind: "summary", digest: `builtin-callback:${operation}` },
				obligations: [],
				origin: "program-callback-summaries",
			});
			editor.setInstructionEffectRefinement(instruction, { effects: refined, proof });
		}
		const change = editor?.commit();
		if (change !== undefined) changes.push(change);
	}
	return changes;
}

export function coreKnownBuiltinInvocationEffects(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreInstructionEffects | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	return !attributes.construct &&
		attributes.argumentMode === undefined &&
		typeof attributes.operation === "string"
		? knownBuiltinInvocationEffects(attributes.operation)
		: undefined;
}

export function coreKnownBuiltinOnlyObservesOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const effects = coreKnownBuiltinInvocationEffects(fn, instruction);
	if (effects === undefined) return false;
	const operation = fn.instructionAttributes(instruction).operation as string;
	// IsArray only follows internal Proxy targets and throws a fresh TypeError on revocation.
	if (operation === "Array.isArray") return true;
	if (
		effects.writes.length > 0 ||
		effects.callsUserCode ||
		effects.maySuspend ||
		effects.mayThrow
	)
		return false;
	const result = builtinNormalResultKinds(operation);
	return result !== undefined && (result & COMPILER_VALUE_KIND_OBJECT) === 0;
}
