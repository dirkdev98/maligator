import { builtinCallbackInvocation } from "../shared/builtin-registry.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	compilerOperatorInputKindsHaveExactNativeSemantics,
} from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { coreBuiltinCallbackOperation } from "./core-ir-call-targets.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type {
	CoreDirectBuiltinCallbackPlan,
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "./core-ir-regions.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreArgumentObservation,
} from "./core-native-entry-analysis.ts";
import type { CoreProgram } from "./core-store.ts";

type CallbackEntry = Pick<
	CoreDirectEntryPlan,
	| "function"
	| "callSites"
	| "parameterRepresentations"
	| "argumentRepresentations"
	| "valueRepresentations"
	| "resultRepresentation"
	| "constantBooleans"
	| "instructionFacts"
>;

export function coreNativeCallbackEntryOpportunities(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	callbacks: ReadonlyArray<CoreDirectBuiltinCallbackPlan>,
) {
	const callbackTargets = new Set(callbacks.map((callback) => callback.target));
	const weights = new Map<CoreFunctionId, Uint8Array>();
	const callWeight = (site: CoreDirectEntryPlan["callSites"][number]): number => {
		let blocks = weights.get(site.caller);
		if (blocks === undefined) {
			const fn = program.function(site.caller);
			blocks = new Uint8Array(fn.blockCapacity);
			blocks.fill(callbackTargets.has(site.caller) ? 4 : 1);
			for (const loop of analyses
				.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
					scope: "function",
					function: site.caller,
				})
				.ordinary().loops) {
				for (const block of loop.blocks)
					blocks[block] = Math.max(blocks[block]!, loop.depth > 1 ? 8 : 4);
			}
			weights.set(site.caller, blocks);
		}
		return blocks[program.function(site.caller).instructionBlock(site.instruction)]!;
	};
	const seeds = new Map<
		string,
		{
			target: CoreFunctionId;
			representations: ReadonlyArray<CorePlanRepresentation>;
			exactArity: boolean;
			calls: Array<CoreDirectEntryPlan["callSites"][number]>;
		}
	>();
	for (const callback of callbacks) {
		const caller = program.function(callback.caller);
		const operation = coreBuiltinCallbackOperation(caller, callback.instruction);
		const invocation =
			operation === undefined ? undefined : builtinCallbackInvocation(operation);
		if (invocation === undefined || operation === undefined) continue;
		const fn = program.function(callback.target);
		const observation = coreArgumentObservation(fn);
		if (
			observation.kind === "general" ||
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor
		)
			continue;
		const exactArity =
			observation.readsCount ||
			observation.indices.length > 0 ||
			observation.restStarts.length > 0;
		const arity = invocation.argumentKinds.length;
		if (
			exactArity &&
			(arity > 16 ||
				observation.indices.some((index) => index >= arity) ||
				observation.restStarts.some((index) => index > arity))
		)
			continue;
		const representations = Array.from(
			{ length: exactArity ? arity : fn.parameterCount },
			(_, index): CorePlanRepresentation =>
				invocation.argumentKinds[index] === "number" ? "f64" : "boxed",
		);
		const key = `${callback.target}:${exactArity}:${representations.join(",")}`;
		const seed = seeds.get(key) ?? {
			target: callback.target,
			representations,
			exactArity,
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
		seeds.set(key, seed);
	}
	const nominatedTargets = new Set<CoreFunctionId>();
	const revisions = new Map<CoreFunctionId, number>();
	return [...seeds.values()].flatMap((seed) => {
		const fn = program.function(seed.target);
		const instructionCount = [...fn.instructionIds()].length;
		if (instructionCount > 512) return [];
		const invocation = builtinCallbackInvocation(
			seed.calls[0]!.builtinCallbackOperation!,
		)!;
		const observation = coreArgumentObservation(fn);
		if (observation.kind === "general") return [];
		const nominated = seed.representations.map((rep, index) =>
			!nominatedTargets.has(seed.target) &&
			invocation.argumentKinds[index] === "any" &&
			((index < fn.parameterCount &&
				fn.valueUseCount(fn.kernel.functionParameter(index)) > 0) ||
				observation.indices.includes(index) ||
				observation.restStarts.some((start) => index >= start))
				? ("f64" as const)
				: rep,
		);
		const triesNumbers = nominated.some(
			(rep, index) => rep !== seed.representations[index],
		);
		if (triesNumbers) nominatedTargets.add(seed.target);
		const revision = (revisions.get(seed.target) ?? 0) + 1;
		revisions.set(seed.target, revision);
		const generatedCode = Math.max(8, instructionCount);
		const numberNominations = nominated.filter(
			(rep, index) => rep !== seed.representations[index],
		).length;
		const compilerWork =
			(generatedCode + fn.valueCapacity) *
				(triesNumbers ? 2 + (numberNominations > 1 ? numberNominations : 0) : 1) +
			seed.calls.length;
		// Each builtin call invokes its callback repeatedly even outside a source loop.
		const runtimeBenefit =
			seed.calls.reduce((sum, site) => sum + callWeight(site), 0) * 32;
		return [
			{
				function: seed.target,
				instruction: seed.calls[0]!.instruction,
				revision,
				generatedCode,
				compilerWork,
				runtimeBenefit,
				resolve(): CallbackEntry | undefined {
					const cfg = analyses
						.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
							scope: "function",
							function: seed.target,
						})
						.exceptional();
					const parametersFor = (
						representations: ReadonlyArray<CorePlanRepresentation>,
					) =>
						Array.from(
							{ length: fn.parameterCount },
							(_, index) => representations[index] ?? "boxed",
						);
					const calls = Object.freeze(seed.calls);
					const baseline = analyzeCoreNativeEntry(
						program,
						cfg,
						parametersFor(seed.representations),
						seed.exactArity ? seed.representations : undefined,
						calls,
					);
					let representations = seed.representations,
						callSites = calls,
						variant = baseline;
					if (triesNumbers) {
						const guardedCalls = Object.freeze(
							calls.map((site) =>
								Object.freeze({ ...site, builtinCallbackNumbers: true as const }),
							),
						);
						let candidate = analyzeCoreNativeEntry(
							program,
							cfg,
							parametersFor(nominated),
							seed.exactArity ? nominated : undefined,
							guardedCalls,
						);
						const baselineNumbers = new Set(
							(baseline.instructionFacts ?? [])
								.filter((site) =>
									site.masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER),
								)
								.map((site) => site.instruction),
						);
						const numericGains = (entry: typeof candidate) =>
							new Set(
								(entry.instructionFacts ?? [])
									.filter(
										(site) =>
											fn.instructionKind(site.instruction) === "operation" &&
											!baselineNumbers.has(site.instruction) &&
											site.masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER) &&
											compilerOperatorInputKindsHaveExactNativeSemantics(
												fn.instructionOpcodeName(site.instruction),
												fn.instructionAttributes(site.instruction).operator,
												site.masks,
											),
									)
									.map((site) => site.instruction),
							);
						const gains = numericGains(candidate);
						if (gains.size > 0) {
							let selected = nominated;
							// A numeric index must not unnecessarily exclude boxed collection values.
							for (let index = 0; index < selected.length; index++) {
								if (selected[index] === seed.representations[index]) continue;
								const relaxed = [...selected];
								relaxed[index] = seed.representations[index]!;
								const relaxedEntry = relaxed.every(
									(rep, index) => rep === seed.representations[index],
								)
									? baseline
									: analyzeCoreNativeEntry(
											program,
											cfg,
											parametersFor(relaxed),
											seed.exactArity ? relaxed : undefined,
											guardedCalls,
										);
								const retained = numericGains(relaxedEntry);
								if ([...gains].some((instruction) => !retained.has(instruction)))
									continue;
								selected = relaxed;
								candidate = relaxedEntry;
							}
							representations = selected;
							callSites = guardedCalls;
							variant = candidate;
						}
					}
					if (representations.every((rep) => rep === "boxed")) return;
					return Object.freeze({
						function: seed.target,
						callSites,
						parameterRepresentations: Object.freeze(parametersFor(representations)),
						...(seed.exactArity ? { argumentRepresentations: representations } : {}),
						...variant,
					});
				},
			},
		];
	});
}
