import { builtinOperationDescriptor } from "../shared/builtin-registry.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreBuiltinCallbackOperation } from "./core-ir-call-targets.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type {
	CoreDirectBuiltinCallbackPlan,
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "./core-ir-regions.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreArgumentObservation,
} from "./core-native-entry-analysis.ts";
import type { CoreProgram } from "./core-store.ts";

interface EntryNode {
	entry: CoreDirectEntryPlan;
	readonly dependents: Set<EntryNode>;
	readonly callees: Map<CoreInstructionId, EntryCall>;
	readonly resultMasks: Map<CoreInstructionId, number>;
}

interface EntryCall {
	readonly callee: EntryNode;
	readonly guarded: boolean;
}

function resultMask(representation: CorePlanRepresentation): number | undefined {
	return representation === "f64"
		? COMPILER_VALUE_KIND_NUMBER
		: representation === "boolean"
			? COMPILER_VALUE_KIND_BOOLEAN
			: representation === "string"
				? COMPILER_VALUE_KIND_STRING
				: undefined;
}

/**
 * Connect scalar contracts inside native variants without strengthening the
 * canonical bodies. Each site chooses one compatible contract and keeps it;
 * later result facts can refine its caller but cannot create an unbounded stream
 * of increasingly specialized siblings. Recursive results start boxed, so a
 * cycle cannot manufacture its own scalar-return proof.
 */
export function connectCoreNativeEntries(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	analyses: CoreAnalysisManager,
	live: ReadonlySet<CoreFunctionId>,
	initial: ReadonlyArray<CoreDirectEntryPlan>,
	callbacks: ReadonlyArray<CoreDirectBuiltinCallbackPlan>,
	admit: (
		target: CoreFunctionId,
		instruction: CoreInstructionId,
		generatedCode: number,
		compilerWork: number,
	) => boolean,
	admitAnalysis: (functionId: CoreFunctionId, compilerWork: number) => boolean,
): ReadonlyArray<CoreDirectEntryPlan> {
	const nodes = new Map<CoreFunctionId, Array<EntryNode>>();
	const pending: Array<EntryNode> = [];
	const queued = new Set<EntryNode>();
	const enqueue = (node: EntryNode) => {
		if (queued.has(node)) return;
		queued.add(node);
		pending.push(node);
	};
	const add = (entry: CoreDirectEntryPlan): EntryNode => {
		const node: EntryNode = {
			entry,
			dependents: new Set(),
			callees: new Map(),
			resultMasks: new Map(),
		};
		const entries = nodes.get(entry.function) ?? [];
		entries.push(node);
		nodes.set(entry.function, entries);
		enqueue(node);
		return node;
	};
	for (const entry of initial) add(entry);
	const plain = (entry: CoreDirectEntryPlan) =>
		entry.argumentRepresentations === undefined && entry.fieldParameters === undefined;
	const cfg = (functionId: CoreFunctionId) =>
		analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functionId,
			})
			.exceptional();
	const signatureKey = (representations: ReadonlyArray<CorePlanRepresentation>) =>
		representations.join(",");
	const declined = new Set<string>();
	const request = (
		target: CoreFunctionId,
		instruction: CoreInstructionId,
		parameters: ReadonlyArray<CorePlanRepresentation>,
		callSites: CoreDirectEntryPlan["callSites"] = Object.freeze([]),
	): EntryNode | undefined => {
		const signature = signatureKey(parameters);
		const entries = nodes.get(target) ?? [];
		const existing = entries.find(
			({ entry }) =>
				plain(entry) && signatureKey(entry.parameterRepresentations) === signature,
		);
		if (existing !== undefined) return existing;
		const key = `${target}:${signature}`;
		if (declined.has(key) || entries.length >= 4) return undefined;
		declined.add(key);
		const fn = program.function(target);
		const instructionCount = [...fn.instructionIds()].length;
		const observation = coreArgumentObservation(fn);
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			instructionCount > 512 ||
			observation.kind === "general" ||
			observation.readsCount ||
			observation.indices.length > 0 ||
			observation.restStarts.length > 0
		)
			return undefined;
		const generatedCode = Math.max(8, instructionCount);
		const compilerWork = generatedCode + fn.valueCapacity;
		const resultOnly = parameters.every((representation) => representation === "boxed");
		// A boxed-input helper can still return a scalar. Charge its proof as
		// discovery so a rejected result does not consume a generated sibling.
		if (
			resultOnly
				? !admitAnalysis(target, compilerWork)
				: !admit(target, instruction, generatedCode, compilerWork)
		)
			return undefined;
		const variant = analyzeCoreNativeEntry(
			fn,
			cfg(target),
			parameters,
			undefined,
			callSites,
		);
		if (
			resultOnly &&
			(variant.resultRepresentation === "boxed" ||
				!admit(target, instruction, generatedCode, 0))
		)
			return undefined;
		return add(
			Object.freeze({
				id: entries.length,
				function: target,
				callSites,
				parameterRepresentations: Object.freeze([...parameters]),
				...variant,
				target: "native",
				fallback: "canonical-core",
				cost: Object.freeze({
					generatedCode,
					compilerWork: resultOnly ? 0 : compilerWork,
					runtimeBenefit: 8,
				}),
			}),
		);
	};
	const callbackSeeds = new Map<
		string,
		{
			target: CoreFunctionId;
			parameters: ReadonlyArray<CorePlanRepresentation>;
			calls: Array<CoreDirectEntryPlan["callSites"][number]>;
		}
	>();
	for (const callback of callbacks) {
		const caller = program.function(callback.caller);
		const operation = coreBuiltinCallbackOperation(caller, callback.instruction);
		const invocation =
			operation === undefined
				? undefined
				: builtinOperationDescriptor(operation)?.callback;
		if (invocation === undefined || operation === undefined) continue;
		const fn = program.function(callback.target);
		if (
			(nodes.get(callback.target) ?? []).some(
				({ entry }) =>
					plain(entry) &&
					entry.parameterRepresentations.some(
						(rep, index) => rep !== "boxed" && index < invocation.argumentKinds.length,
					),
			)
		)
			continue;
		const parameters = Array.from(
			{ length: fn.parameterCount },
			(_, index): CorePlanRepresentation =>
				invocation.argumentKinds[index] === "number" ? "f64" : "boxed",
		);
		if (
			!parameters.some(
				(rep, index) =>
					rep !== "boxed" && fn.valueUseCount(fn.kernel.functionParameter(index)) > 0,
			)
		)
			continue;
		const key = `${callback.target}:${signatureKey(parameters)}`;
		const seed = callbackSeeds.get(key) ?? {
			target: callback.target,
			parameters,
			calls: [],
		};
		seed.calls.push(
			Object.freeze({
				caller: callback.caller,
				instruction: callback.instruction,
				guarded: true,
				builtinCallbackOperation: operation,
			}),
		);
		callbackSeeds.set(key, seed);
	}
	for (const seed of callbackSeeds.values()) {
		if (!admitAnalysis(seed.target, seed.parameters.length + seed.calls.length)) continue;
		request(
			seed.target,
			seed.calls[0]!.instruction,
			seed.parameters,
			Object.freeze(seed.calls),
		);
	}
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const node = pending[cursor]!;
		queued.delete(node);
		const entry = node.entry;
		if (!plain(entry) || entry.valueRepresentations === undefined) continue;
		const fn = program.function(entry.function);
		const outgoing = summaries.targets.outgoing(entry.function);
		if (
			outgoing.length === 0 ||
			!admitAnalysis(entry.function, fn.valueCapacity + [...fn.instructionIds()].length)
		)
			continue;
		const reachable = cfg(entry.function).reachable;
		const newCalls: Array<[CoreInstructionId, EntryCall]> = [];
		for (const site of outgoing) {
			if (
				node.callees.has(site.instruction) ||
				site.targets.functions.length === 0 ||
				site.targets.functions.length > 4 ||
				site.arguments === undefined ||
				!fn.isInstructionLive(site.instruction) ||
				!reachable.has(fn.instructionBlock(site.instruction)) ||
				fn.instructionOpcodeName(site.instruction) !== "call" ||
				fn.instructionAttributes(site.instruction)[
					CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
				] === true
			)
				continue;
			for (const target of site.targets.functions) {
				if (!live.has(target)) continue;
				const parameters = Array.from(
					{ length: program.function(target).parameterCount },
					(_, index): CorePlanRepresentation => {
						const argument = site.arguments![index];
						return argument === undefined
							? "boxed"
							: entry.valueRepresentations![argument]!;
					},
				);
				const callee = request(target, site.instruction, parameters);
				if (callee === undefined) continue;
				newCalls.push([
					site.instruction,
					{
						callee,
						guarded:
							site.targets.functions.length > 1 ||
							site.open ||
							site.targets.anyScript ||
							site.targets.opaque ||
							site.targets.nonCallable,
					},
				]);
				// One sibling per call site bounds code growth. Other hinted or
				// opaque targets keep the generic branch of this identity guard.
				break;
			}
		}
		const masks = new Map(node.resultMasks);
		let changed = newCalls.length > 0;
		for (const [instruction, { callee, guarded }] of [...node.callees, ...newCalls]) {
			// Identity guards select an ABI, but an open fallback can return any
			// value. Its result must never enter the caller's scalar proof, even
			// after the hinted callee's result is refined in a later worklist turn.
			if (guarded) continue;
			const mask = resultMask(callee.entry.resultRepresentation);
			if (mask === undefined || masks.get(instruction) === mask) continue;
			masks.set(instruction, mask);
			changed = true;
		}
		if (!changed) continue;
		for (const [instruction, call] of newCalls) {
			node.callees.set(instruction, call);
			if (!call.guarded) call.callee.dependents.add(node);
		}
		const callOverrides = Object.freeze(
			[...node.callees]
				.sort(([left], [right]) => left - right)
				.map(([instruction, { callee, guarded }]) =>
					Object.freeze({
						instruction,
						target: callee.entry.function,
						entryId: callee.entry.id,
						...(guarded ? { guarded: true as const } : {}),
					}),
				),
		);
		const variant = analyzeCoreNativeEntry(
			fn,
			cfg(entry.function),
			entry.parameterRepresentations,
			undefined,
			entry.callSites,
			undefined,
			masks,
			callOverrides,
		);
		node.entry = Object.freeze({ ...entry, ...variant, callOverrides });
		for (const [instruction, mask] of masks) node.resultMasks.set(instruction, mask);
		if (
			variant.valueRepresentations.some(
				(representation, value) => representation !== entry.valueRepresentations![value],
			)
		)
			enqueue(node);
		if (variant.resultRepresentation !== entry.resultRepresentation)
			for (const dependent of node.dependents) enqueue(dependent);
	}
	return [...nodes]
		.sort(([left], [right]) => left - right)
		.flatMap(([, entries]) => entries.map(({ entry }) => entry));
}
