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
import { CORE_PROGRAM_FLOW_ALL_DIMENSIONS } from "./core-program-flow.ts";

export interface CoreProgramFlowState {
	readonly targets: ReturnType<typeof analyzeCoreCallGraph>;
	readonly summaries: ReturnType<typeof analyzeProgramSummaries>;
	readonly valueKinds: ReturnType<typeof solveCoreProgramValueKinds>;
	readonly reachability: CoreFunctionReachabilityState;
}

const CORE_PROGRAM_FLOW_ENGINE_CONSUMER = 4;

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
		const epoch = programFlow.refresh(
			CORE_PROGRAM_FLOW_ENGINE_CONSUMER,
			CORE_PROGRAM_FLOW_ALL_DIMENSIONS,
		);
		const dirtyFunctions: Array<CoreFunctionId> = [];
		if (prior !== undefined) {
			for (let index = 0; index < epoch.dirtyFunctionCount; index++)
				dirtyFunctions.push(epoch.dirtyFunctionAt(index));
		}
		const targets = analyzeCoreCallGraph(
			program,
			context.facts.closure.sourceClosure.kind === "known",
			prior?.targets,
			(functionId) =>
				get(CORE_CONTROL_FLOW_ANALYSIS, {
					scope: "function",
					function: functionId,
				}),
			context,
			dirtyFunctions,
			(functionId) => programFlow.local(functionId),
		);
		const exceptionalControl = (functionId: CoreFunctionId) =>
			get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
				scope: "function" as const,
				function: functionId,
			});
		const summaries = analyzeProgramSummaries(
			program,
			context,
			targets,
			exceptionalControl,
			programFlow.topology(targets.graph),
			prior?.summaries,
			dirtyFunctions,
		);
		const valueKinds = solveCoreProgramValueKinds(
			program,
			targets,
			(functionId) => summaries.summary(functionId)?.externallyReachable === true,
			exceptionalControl,
			prior?.valueKinds,
			dirtyFunctions,
			summaries.changedFunctions,
		);
		const reachability = analyzeCoreFunctionReachability(
			program,
			targets,
			context,
			prior?.reachability,
			dirtyFunctions,
			(functionId) => programFlow.local(functionId),
		);
		return Object.freeze({ targets, summaries, valueKinds, reachability });
	},
};
