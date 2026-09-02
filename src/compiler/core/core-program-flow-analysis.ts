import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { analyzeCoreCallGraph } from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import { analyzeCoreFunctionReachability } from "./core-ir-reachability.ts";
import type { CoreFunctionReachabilityState } from "./core-ir-reachability.ts";
import { analyzeProgramSummaries } from "./core-ir-summaries.ts";
import { solveCoreProgramValueKinds } from "./core-ir-value-kinds.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import {
	CORE_PROGRAM_FLOW_ALL_DIMENSIONS,
	CORE_PROGRAM_FLOW_REACHABILITY,
	CORE_PROGRAM_FLOW_RETURN_KIND,
	CORE_PROGRAM_FLOW_SUMMARIES,
	CORE_PROGRAM_FLOW_TARGETS,
} from "./core-program-flow.ts";

export interface CoreProgramFlowState {
	readonly flowRevision: number;
	readonly targets: ReturnType<typeof analyzeCoreCallGraph>;
	readonly summaries: ReturnType<typeof analyzeProgramSummaries>;
	readonly valueKinds: ReturnType<typeof solveCoreProgramValueKinds>;
	readonly reachability: CoreFunctionReachabilityState;
}

export const CORE_PROGRAM_FLOW_ANALYSIS: CoreAnalysisDefinition<CoreProgramFlowState> = {
	key: "program-flow",
	scope: "program",
	functionDependencies: [
		"body",
		"cfg",
		"exceptionFlow",
		"calls",
		"memoryEffects",
		"facts",
		"representations",
	],
	programDependencies: ["functions", "data", "calls", "facts", "representations"],
	contextIdentity(context) {
		return context.facts.closure.sourceClosure.kind;
	},
	compute({ program, context, request, previous, get, programFlow }) {
		if (request.scope !== "program") throw new Error("Expected program analysis");
		const prior = previous as CoreProgramFlowState | undefined;
		const epoch = programFlow.refresh(CORE_PROGRAM_FLOW_ALL_DIMENSIONS);
		const dirtyFunctions = new Array<CoreFunctionId>();
		if (prior !== undefined) {
			for (let index = 0; index < epoch.dirtyFunctionCount; index++)
				dirtyFunctions.push(epoch.dirtyFunctionAt(index));
		}
		const dirtyFor = (dimensions: number): Array<CoreFunctionId> =>
			dirtyFunctions.filter(
				(functionId) => (epoch.dirtyDimensions(functionId) & dimensions) !== 0,
			);
		const unjournaledInvalidation =
			prior !== undefined && epoch.revision === prior.flowRevision;
		const targetDirty = dirtyFor(CORE_PROGRAM_FLOW_TARGETS);
		const targets =
			prior !== undefined && !unjournaledInvalidation && targetDirty.length === 0
				? prior.targets
				: analyzeCoreCallGraph(
						program,
						context.facts.closure.sourceClosure.kind === "known",
						prior?.targets,
						(functionId) =>
							get(CORE_CONTROL_FLOW_ANALYSIS, {
								scope: "function",
								function: functionId,
							}),
						context,
						targetDirty,
						(functionId) => programFlow.local(functionId),
					);
		const exceptionalControl = (functionId: CoreFunctionId) =>
			get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
				scope: "function" as const,
				function: functionId,
			});
		const summaryDirty = dirtyFor(CORE_PROGRAM_FLOW_SUMMARIES);
		const targetsChanged = targets !== prior?.targets;
		const summaries =
			prior !== undefined &&
			!unjournaledInvalidation &&
			summaryDirty.length === 0 &&
			!targetsChanged
				? prior.summaries
				: analyzeProgramSummaries(
						program,
						context,
						targets,
						exceptionalControl,
						programFlow.topology(targets.graph),
						programFlow,
						prior?.summaries,
						summaryDirty,
					);
		const externallyReachableChanges = new Set(
			[...summaries.changedFunctions].filter(
				(functionId) =>
					prior?.summaries.summary(functionId)?.externallyReachable !==
					summaries.summary(functionId)?.externallyReachable,
			),
		);
		const valueKindDirty = dirtyFor(CORE_PROGRAM_FLOW_RETURN_KIND);
		const valueKinds =
			prior !== undefined &&
			!unjournaledInvalidation &&
			valueKindDirty.length === 0 &&
			!targetsChanged &&
			externallyReachableChanges.size === 0
				? prior.valueKinds
				: solveCoreProgramValueKinds(
						program,
						targets,
						(functionId) => summaries.summary(functionId)?.externallyReachable === true,
						exceptionalControl,
						programFlow.topology(targets.graph),
						programFlow,
						prior?.valueKinds,
						valueKindDirty,
						externallyReachableChanges,
					);
		const reachabilityDirty = dirtyFor(CORE_PROGRAM_FLOW_REACHABILITY);
		const reachability =
			prior !== undefined &&
			!unjournaledInvalidation &&
			reachabilityDirty.length === 0 &&
			!targetsChanged
				? prior.reachability
				: analyzeCoreFunctionReachability(
						program,
						targets,
						context,
						prior?.reachability,
						reachabilityDirty,
						(functionId) => programFlow.local(functionId),
						programFlow.topology(targets.graph),
						programFlow,
					);
		return Object.freeze({
			flowRevision: epoch.revision,
			targets,
			summaries,
			valueKinds,
			reachability,
		});
	},
};

function programFlowView<Key extends keyof CoreProgramFlowState>(
	key: Key,
): CoreAnalysisDefinition<CoreProgramFlowState[Key]> {
	return {
		key: `program-flow-${key}`,
		scope: "program",
		functionDependencies: CORE_PROGRAM_FLOW_ANALYSIS.functionDependencies,
		programDependencies: CORE_PROGRAM_FLOW_ANALYSIS.programDependencies,
		contextIdentity: CORE_PROGRAM_FLOW_ANALYSIS.contextIdentity,
		compute({ request, get }) {
			return get(CORE_PROGRAM_FLOW_ANALYSIS, request)[key];
		},
	};
}

export const CORE_CALL_GRAPH_ANALYSIS = programFlowView("targets");
export const CORE_PROGRAM_SUMMARIES_ANALYSIS = programFlowView("summaries");
export const CORE_PROGRAM_VALUE_KIND_ANALYSIS = programFlowView("valueKinds");
export const CORE_FUNCTION_REACHABILITY_ANALYSIS = programFlowView("reachability");
