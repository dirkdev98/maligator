import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreDirectEntryPlan, CorePlanRepresentation } from "./core-ir-regions.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreNativeEntryControlFlow,
	coreArgumentObservation,
	compactCoreNativeEntries,
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

export interface CoreNativeEntryGraph {
	readonly entries: ReadonlyArray<CoreDirectEntryPlan>;
	/** Original IDs identify the provisional budgets, before surviving siblings are compacted. */
	readonly retiredEntries: ReadonlyArray<CoreDirectEntryPlan>;
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
	admit: (
		target: CoreFunctionId,
		instruction: CoreInstructionId,
		generatedCode: number,
		compilerWork: number,
		entryId: number,
	) => boolean,
	admitAnalysis: (functionId: CoreFunctionId, compilerWork: number) => boolean,
): CoreNativeEntryGraph {
	const nodes = new Map<CoreFunctionId, Array<EntryNode>>();
	const roots = new Set<EntryNode>();
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
	for (const entry of initial) roots.add(add(entry));
	// Every variant of a record call's caller exchanges records through caller storage.
	const recordCalls = new Set(
		initial.flatMap((entry) =>
			entry.resultFields === undefined && entry.recordParameters === undefined
				? []
				: entry.callSites.map((site) => `${site.caller}:${site.instruction}`),
		),
	);
	const plain = (entry: CoreDirectEntryPlan) =>
		entry.argumentRepresentations === undefined &&
		entry.fieldParameters === undefined &&
		entry.resultFields === undefined &&
		entry.recordParameters === undefined;
	const cfg = (functionId: CoreFunctionId) =>
		analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functionId,
			})
			.exceptional();
	const signatureKey = (representations: ReadonlyArray<CorePlanRepresentation>) =>
		representations.join(",");
	const entrySignature = (
		parameters: ReadonlyArray<CorePlanRepresentation>,
		arguments_: ReadonlyArray<CorePlanRepresentation> | undefined,
	) =>
		`${signatureKey(parameters)}:${arguments_ === undefined ? "plain" : signatureKey(arguments_)}`;
	const observations = new Map<
		CoreFunctionId,
		ReturnType<typeof coreArgumentObservation>
	>();
	const observationFor = (target: CoreFunctionId) => {
		let observation = observations.get(target);
		if (observation === undefined) {
			observation = coreArgumentObservation(program.function(target));
			observations.set(target, observation);
		}
		return observation;
	};
	const declined = new Set<string>();
	const candidateCosts = new Map<
		string,
		{ generatedCode: number; compilerWork: number } | undefined
	>();
	const candidateCost = (target: CoreFunctionId, argumentCount?: number) => {
		const key = `${target}:${argumentCount ?? "plain"}`;
		if (candidateCosts.has(key)) return candidateCosts.get(key);
		const fn = program.function(target);
		const instructionCount = [...fn.instructionIds()].length;
		const observation = observationFor(target);
		const eligible =
			!fn.isGenerator &&
			!fn.isAsync &&
			!fn.metadata.isClassConstructor &&
			!fn.metadata.isDerivedConstructor &&
			instructionCount <= 512 &&
			observation.kind !== "general" &&
			(argumentCount === undefined
				? !observation.readsCount &&
					observation.indices.length === 0 &&
					observation.restStarts.length === 0
				: argumentCount <= 16 &&
					observation.indices.every((index) => index < argumentCount) &&
					observation.restStarts.every((index) => index <= argumentCount));
		const generatedCode = Math.max(8, instructionCount);
		const cost = eligible
			? { generatedCode, compilerWork: generatedCode + fn.valueCapacity }
			: undefined;
		candidateCosts.set(key, cost);
		return cost;
	};
	const request = (
		target: CoreFunctionId,
		instruction: CoreInstructionId,
		parameters: ReadonlyArray<CorePlanRepresentation>,
		callSites: CoreDirectEntryPlan["callSites"] = Object.freeze([]),
		prepared?: ReturnType<typeof analyzeCoreNativeEntry>,
		arguments_?: ReadonlyArray<CorePlanRepresentation>,
	): EntryNode | undefined => {
		const signature = entrySignature(parameters, arguments_);
		const entries = nodes.get(target) ?? [];
		const existing = entries.find(
			({ entry }) =>
				entry.fieldParameters === undefined &&
				// Only the calls whose record proofs it carries may use a record entry.
				entry.resultFields === undefined &&
				entry.recordParameters === undefined &&
				entrySignature(entry.parameterRepresentations, entry.argumentRepresentations) ===
					signature,
		);
		if (existing !== undefined) return existing;
		const key = `${target}:${signature}`;
		if (declined.has(key) || entries.length >= 4) return undefined;
		declined.add(key);
		const cost = candidateCost(target, arguments_?.length);
		if (cost === undefined) return undefined;
		const generatedCode = cost.generatedCode;
		const compilerWork = prepared === undefined ? cost.compilerWork : 0;
		const resultOnly = (arguments_ ?? parameters).every(
			(representation) => representation === "boxed",
		);
		// A boxed-input helper can still return a scalar. Charge its proof as
		// discovery so a rejected result does not consume a generated sibling.
		if (
			resultOnly
				? !admitAnalysis(target, compilerWork)
				: !admit(target, instruction, generatedCode, compilerWork, entries.length)
		)
			return undefined;
		const variant =
			prepared ??
			analyzeCoreNativeEntry(program, cfg(target), parameters, arguments_, callSites);
		if (
			resultOnly &&
			(variant.resultRepresentation === "boxed" ||
				!admit(target, instruction, generatedCode, 0, entries.length))
		)
			return undefined;
		return add(
			Object.freeze({
				id: entries.length,
				function: target,
				callSites,
				parameterRepresentations: Object.freeze([...parameters]),
				...(arguments_ === undefined
					? {}
					: { argumentRepresentations: Object.freeze([...arguments_]) }),
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
		const reachable =
			coreNativeEntryControlFlow(fn, entry)?.blocks ?? cfg(entry.function).reachable;
		const newCalls: Array<[CoreInstructionId, EntryCall]> = [];
		for (const site of outgoing) {
			if (
				node.callees.has(site.instruction) ||
				recordCalls.has(`${entry.function}:${site.instruction}`) ||
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
			program,
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
	const retained = new Set(roots);
	const required = [...roots];
	for (let cursor = 0; cursor < required.length; cursor++) {
		const node = required[cursor]!;
		const fn = program.function(node.entry.function);
		const reachable = coreNativeEntryControlFlow(fn, node.entry)?.blocks;
		for (const call of node.entry.callOverrides ?? []) {
			if (
				reachable !== undefined &&
				!reachable.has(fn.instructionBlock(call.instruction))
			)
				continue;
			const callee = nodes
				.get(call.target)
				?.find(({ entry }) => entry.id === call.entryId);
			if (callee === undefined) throw new RangeError("Dangling native entry nomination");
			if (!retained.has(callee)) {
				retained.add(callee);
				required.push(callee);
			}
		}
	}
	// Semantic return facts survive retirement of the emitted ABI, keeping loop proofs monotone.
	const ordered = [...nodes]
		.sort(([left], [right]) => left - right)
		.flatMap(([, entries]) => entries);
	return {
		entries: compactCoreNativeEntries(
			program,
			ordered.filter((node) => retained.has(node)).map((node) => node.entry),
		),
		retiredEntries: ordered
			.filter((node) => !retained.has(node))
			.map((node) => node.entry),
	};
}
