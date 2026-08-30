import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationPassDelta,
} from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type { CoreProgram } from "./core-ir.ts";

/** A captured cell: its function index or negative per-iteration scope id, plus slot. */
export interface CoreCapturedSlotRef {
	readonly owner: number;
	readonly index: number;
}

export interface CoreHostInstallCandidate {
	readonly installer: string;
	readonly exports: ReadonlyArray<{ readonly name: string; readonly slot: number }>;
}

/**
 * Frontend-derived program information normalized before Core optimization.
 *
 * Core instructions and values never retain the semantic tree. The small pieces
 * of frontend information that whole-program analysis or image linking needs are
 * copied into this closed contract instead.
 */
export interface CoreProgramData {
	readonly entrypointPath: string;
	readonly moduleEvaluationOrder: ReadonlyArray<string>;
	/** Source text retained for stable profile-site identities and diagnostics. */
	readonly sourceFiles: ReadonlyArray<{
		readonly path: string;
		readonly contents: string;
	}>;
	readonly cjsModuleFunctionIndices: ReadonlyArray<number>;
	readonly hostInstallCandidates: ReadonlyArray<CoreHostInstallCandidate>;
	/** Source-immutable cells, plus graph-proven activation-private cells. */
	readonly singleAssignmentGlobalSlots: ReadonlyArray<number>;
	/** Source-immutable cells, plus captured lets with one named non-TDZ writer. */
	readonly singleAssignmentCapturedSlots: ReadonlyArray<CoreCapturedSlotRef>;
	readonly retainedHostInstallers: ReadonlyArray<string>;
}

/** Analysis and diagnostics that accompany, but are not part of, canonical SSA. */
export interface CoreCompilationContext {
	readonly facts: CompilerProgramFacts;
	readonly data: CoreProgramData;
	readonly optimizationDecisions?: ReadonlyArray<CompilerOptimizationDecision>;
	readonly optimizationTrace?: ReadonlyArray<OptimizationPassDelta>;
}

/** Product compiler boundary: pure Core SSA plus its explicit compilation context. */
export interface CoreCompilation {
	readonly program: CoreProgram;
	readonly context: CoreCompilationContext;
	/** Ephemeral final-graph analyses consumed by the immediately following target
	 * boundary. Target lowering does not retain them in the Program Image. */
	readonly targetAnalyses?: {
		readonly summaries: CoreProgramSummaries;
	};
}

export function coreCapturedSlotKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

/** Captured cells whose complete write graph is visible to Core. */
export function coreClosedCapturedValueSlots(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
): ReadonlySet<string> {
	const slots = new Set(
		(context?.data.singleAssignmentCapturedSlots ?? []).map(({ owner, index }) =>
			coreCapturedSlotKey(owner, index),
		),
	);
	if (context?.facts.closure.sourceClosure.kind !== "known") return slots;
	const mapped = new Set(
		program.functions.flatMap((fn) =>
			fn.metadata.mappedArgumentSlots.map((index) =>
				coreCapturedSlotKey(fn.functionIndex, index),
			),
		),
	);
	for (const key of mapped) slots.delete(key);
	for (const fn of program.functions) {
		for (const instruction of fn.blocks.flatMap(({ instructions }) => instructions)) {
			if (
				instruction.opcode !== "loadCaptured" &&
				instruction.opcode !== "storeCaptured"
			) {
				continue;
			}
			const owner = instruction.attributes.functionIndex;
			const index = instruction.attributes.index;
			if (typeof owner !== "number" || typeof index !== "number") continue;
			const key = coreCapturedSlotKey(owner, index);
			if (!mapped.has(key)) slots.add(key);
		}
	}
	return slots;
}

/** Normalize the only semantic-program fields retained after frontend lowering. */
export function coreProgramDataFromSemantic(
	semantic: Pick<SemanticProgram, "entrypointPath" | "files" | "graph">,
	data: Omit<CoreProgramData, "entrypointPath" | "moduleEvaluationOrder" | "sourceFiles">,
): CoreProgramData {
	return {
		entrypointPath: semantic.entrypointPath,
		moduleEvaluationOrder: [
			...(semantic.graph?.evaluationOrder ?? [semantic.entrypointPath]),
		],
		sourceFiles: semantic.files.map(({ path, contents }) => ({ path, contents })),
		...data,
	};
}
