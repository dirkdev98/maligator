import type { PlatformData } from "../../platform/catalog.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type { SourceCallSite } from "../frontend/source-function-origins.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { VerifiedCoreOptimizationPlan } from "./core-ir-regions.ts";
import type { CoreProgram, SealedCoreProgram } from "./core-ir.ts";

/** A captured cell: its function index or negative per-iteration scope id, plus slot. */
export interface CoreCapturedSlotRef {
	readonly owner: number;
	readonly index: number;
}

export interface CoreHostInstallCandidate {
	readonly installer: string;
	readonly exports: ReadonlyArray<{
		readonly name: string;
		readonly slot: number;
		readonly constant?: PlatformData;
	}>;
}

/**
 * Frontend-derived program information normalized before Core optimization.
 *
 * Core instructions and values never retain the semantic tree. The small pieces
 * of frontend information that whole-program analysis or image linking needs are
 * copied into this closed contract instead.
 */
export interface CoreProgramData {
	readonly sourceCallSites?: ReadonlyArray<SourceCallSite>;
	readonly entrypointPath: string;
	readonly moduleEvaluationOrder: ReadonlyArray<string>;
	/** Source text retained for stable profile-site identities and diagnostics. */
	readonly sourceFiles: ReadonlyArray<{
		readonly path: string;
		readonly contents: string;
	}>;
	readonly cjsModuleFunctionIndices: ReadonlyArray<number>;
	readonly pureModuleInitializers?: ReadonlyArray<{
		readonly functionIndex: number;
		readonly exportSlots: ReadonlyArray<number>;
	}>;
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
}

const closedGlobalSlotMembershipBySource = new WeakMap<
	ReadonlyArray<number>,
	ReadonlySet<number>
>();

export function coreClosedGlobalSlotMembership(
	context: CoreCompilationContext,
): ReadonlySet<number> {
	const slots = context.data.singleAssignmentGlobalSlots;
	let membership = closedGlobalSlotMembershipBySource.get(slots);
	if (membership === undefined) {
		membership = new Set(slots);
		closedGlobalSlotMembershipBySource.set(slots, membership);
	}
	return membership;
}

/** Mutable construction boundary consumed only by Core optimization. */
export interface ConstructedCoreCompilation {
	readonly program: CoreProgram;
	readonly context: CoreCompilationContext;
}

/** Product compiler boundary: sealed Core SSA plus its explicit lowering plan. */
export interface CoreCompilation {
	readonly program: SealedCoreProgram;
	readonly context: CoreCompilationContext;
	readonly plan: VerifiedCoreOptimizationPlan;
}

/** Captured cells whose complete write graph is visible to Core. */
export function coreClosedCapturedValueSlots(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
): ReadonlyArray<CoreCapturedSlotRef> {
	const slots = (context?.data.singleAssignmentCapturedSlots ?? []).map((slot) => ({
		...slot,
	}));
	if (context?.facts.closure.sourceClosure.kind !== "known") return slots;
	const mapped = new Map<number, Set<number>>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const index of fn.metadata.mappedArgumentSlots) {
			const indices = mapped.get(functionId) ?? new Set<number>();
			indices.add(index);
			mapped.set(functionId, indices);
		}
	}
	for (let index = slots.length - 1; index >= 0; index--) {
		const slot = slots[index]!;
		if (mapped.get(slot.owner)?.has(slot.index)) slots.splice(index, 1);
	}
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "loadCaptured" && opcode !== "storeCaptured") {
				continue;
			}
			const attributes = fn.instructionAttributes(instruction);
			const owner = attributes.functionIndex;
			const index = attributes.index;
			if (typeof owner !== "number" || typeof index !== "number") continue;
			if (
				!mapped.get(owner)?.has(index) &&
				!slots.some((slot) => slot.owner === owner && slot.index === index)
			)
				slots.push({ owner, index });
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
