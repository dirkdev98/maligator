import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CALL_GRAPH_ANALYSIS,
} from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";

export type CoreFunctionReachabilityReason =
	| "program-entry"
	| "commonjs-module"
	| "host-install"
	| "finite-call"
	| "any-script"
	| "runtime-identity"
	| "inline-source";

export interface CoreFunctionReachabilityStatistics {
	readonly functions: number;
	readonly functionsScanned: number;
	readonly callEdgesFollowed: number;
	readonly structuralEdgesFollowed: number;
	readonly deadFunctions: number;
}

export interface CoreFunctionReachability {
	readonly executable: ReadonlySet<CoreFunctionId>;
	readonly retained: ReadonlySet<CoreFunctionId>;
	readonly dead: ReadonlySet<CoreFunctionId>;
	readonly liveFunctions: ReadonlyArray<CoreFunctionId>;
	readonly reasons: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreFunctionReachabilityReason>
	>;
	readonly sourceClosed: boolean;
	readonly statistics: CoreFunctionReachabilityStatistics;
}

const FUNCTION_INDEX_ATTRIBUTES = new Set([
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
]);

function validFunction(
	program: CoreProgram,
	value: unknown,
): value is CoreFunctionId {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value >= program.functionCapacity
	) return false;
	try {
		program.function(value as CoreFunctionId);
		return true;
	} catch {
		return false;
	}
}

function sourceFunctionIndices(
	program: CoreProgram,
	initial: number | undefined,
): ReadonlyArray<CoreFunctionId> {
	const functions = new Set<CoreFunctionId>();
	const seen = new Set<number>();
	let position = initial;
	while (
		position !== undefined &&
		position >= 0 &&
		position < program.sourcePositions.length &&
		!seen.has(position)
	) {
		seen.add(position);
		const source = program.sourcePositions[position]!;
		if (validFunction(program, source.inlinedFunctionIndex)) {
			functions.add(source.inlinedFunctionIndex);
		}
		position = source.callerPosId;
	}
	return [...functions];
}

export function analyzeCoreFunctionReachability(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
): CoreFunctionReachability {
	const all = [...program.functionIds()];
	const reasons = new Map<
		CoreFunctionId,
		Set<CoreFunctionReachabilityReason>
	>();
	const executable = new Set<CoreFunctionId>();
	const pending: Array<CoreFunctionId> = [];
	let callEdgesFollowed = 0;
	let structuralEdgesFollowed = 0;
	const enter = (
		candidate: unknown,
		reason: CoreFunctionReachabilityReason,
	): void => {
		if (!validFunction(program, candidate)) return;
		const current = reasons.get(candidate) ?? new Set();
		current.add(reason);
		reasons.set(candidate, current);
		if (executable.has(candidate)) return;
		executable.add(candidate);
		pending.push(candidate);
	};

	if (!targets.sourceClosed) {
		for (const functionId of all) enter(functionId, "any-script");
	} else {
		enter(all[0], "program-entry");
		for (const functionId of context.data.cjsModuleFunctionIndices) {
			enter(functionId, "commonjs-module");
		}
	}

	for (const candidate of context.data.hostInstallCandidates) {
		for (const { slot } of candidate.exports) {
			for (const functionId of all) {
				const fn = program.function(functionId);
				for (const block of fn.blockIds()) {
					for (const instruction of fn.bodyInstructionIds(block)) {
						if (
							fn.instructionOpcodeName(instruction) !== "storeGlobal" ||
							fn.instructionAttributes(instruction).index !== slot
						) continue;
						const value = fn.instructionOperands(instruction)[0];
						if (value === undefined) continue;
						for (const target of targets.targets(functionId, value).functions) {
							enter(target, "host-install");
						}
					}
				}
			}
		}
	}

	let functionsScanned = 0;
	while (pending.length > 0) {
		const functionId = pending.pop()!;
		functionsScanned++;
		const fn = program.function(functionId);
		for (const site of targets.outgoing(functionId)) {
			if (site.targets.anyScript) {
				for (const target of all) {
					enter(target, "any-script");
					callEdgesFollowed++;
				}
			} else {
				for (const target of site.targets.functions) {
					enter(target, "finite-call");
					callEdgesFollowed++;
				}
			}
		}
		for (const instruction of fn.instructionIds()) {
			for (const sourceFunction of sourceFunctionIndices(
				program,
				fn.instructionSourcePosition(instruction),
			)) {
				enter(sourceFunction, "inline-source");
				structuralEdgesFollowed++;
			}
			if (fn.instructionKind(instruction) !== "operation") continue;
			const attributes = fn.instructionAttributes(instruction);
			for (const key of FUNCTION_INDEX_ATTRIBUTES) {
				const target = attributes[key];
				if (!validFunction(program, target)) continue;
				enter(target, "runtime-identity");
				structuralEdgesFollowed++;
			}
			const guarded = attributes.guardedFunctionIndices;
			if (!Array.isArray(guarded)) continue;
			for (const target of guarded) {
				if (!validFunction(program, target)) continue;
				enter(target, "runtime-identity");
				structuralEdgesFollowed++;
			}
		}
	}
	const dead = new Set(all.filter((functionId) => !executable.has(functionId)));
	const liveFunctions = Object.freeze(
		[...executable].sort((left, right) => left - right),
	);
	return Object.freeze({
		executable,
		retained: executable,
		dead,
		liveFunctions,
		reasons,
		sourceClosed: targets.sourceClosed,
		statistics: Object.freeze({
			functions: all.length,
			functionsScanned,
			callEdgesFollowed,
			structuralEdgesFollowed,
			deadFunctions: dead.size,
		}),
	});
}

export const CORE_FUNCTION_REACHABILITY_ANALYSIS: CoreAnalysisDefinition<CoreFunctionReachability> = {
	key: "function-reachability",
	scope: "program",
	functionDependencies: ["body", "cfg", "calls"],
	programDependencies: ["functions", "data", "calls", "specializationInputs"],
	contextIdentity(context) {
		return context.facts.closure.sourceClosure.kind;
	},
	compute({ program, context, request, previous }) {
		if (request.scope !== "program") throw new Error("Expected program analysis request");
		const targets = CORE_CALL_GRAPH_ANALYSIS.compute({
			program,
			context,
			request,
			previous: undefined,
		});
		void previous;
		return analyzeCoreFunctionReachability(program, targets, context);
	},
};
