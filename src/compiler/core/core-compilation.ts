import type { FfiDirectEntry } from "../../build-config-values.ts";
import type { PlatformData } from "../../platform/catalog.ts";
import type { ExternalModuleInterface } from "../frontend/module-graph.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type { SourceCallSite } from "../frontend/source-function-origins.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { VerifiedCoreOptimizationPlan } from "./core-ir-regions.ts";
import type { CoreProgram, SealedCoreProgram } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/** A captured cell: its function index or negative per-iteration scope id, plus slot. */
export interface CoreCapturedSlotRef {
	readonly owner: number;
	readonly index: number;
}

export interface CoreInitializedCapturedRead extends CoreCapturedSlotRef {
	readonly function: number;
}

export interface CoreHostInstallCandidate {
	readonly installer: string;
	readonly exports: ReadonlyArray<{
		readonly name: string;
		readonly slot: number;
		readonly constant?: PlatformData;
		/** A C entry native code may call instead of the installed function. */
		readonly direct?: FfiDirectEntry;
	}>;
}

/**
 * A module binding, namespace cache slot, or CommonJS module that one image of a
 * relocatable program shares with another. Module paths are the identity the
 * loader matches imports against exports by.
 */
export interface CoreModuleLink {
	readonly kind: "binding" | "namespace" | "cjs";
	readonly module: string;
	/** The export name of a binding link; empty for namespace and CommonJS links. */
	readonly name: string;
	/** A global slot, or the CommonJS module id of a `cjs` link. */
	readonly slot: number;
}

export interface CoreModuleLinks {
	/** Slots the loader aliases to an earlier image's exports; never written here. */
	readonly imports: ReadonlyArray<CoreModuleLink>;
	/** Slots later images read and alias; their stores are externally observable. */
	readonly exports: ReadonlyArray<CoreModuleLink>;
	/** What later images compile against for each module this image publishes. */
	readonly interfaces: ReadonlyArray<CoreModuleInterface>;
}

export interface CoreModuleInterface extends ExternalModuleInterface {
	readonly module: string;
}

/**
 * Frontend-derived program information normalized before Core optimization.
 *
 * Core instructions and values never retain the semantic tree. The small pieces
 * of frontend information that whole-program analysis or image linking needs are
 * copied into this closed contract instead.
 */
export interface CoreProgramData {
	/** Only module evaluation can initialize these unobservable private-name cells. */
	readonly modulePrivateNames?: ReadonlyArray<{
		readonly slot: number;
		readonly evaluator: number;
	}>;
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
		readonly bindingSlots: ReadonlyArray<number>;
	}>;
	readonly hostInstallCandidates: ReadonlyArray<CoreHostInstallCandidate>;
	/** Source-immutable cells, plus graph-proven activation-private cells. */
	readonly singleAssignmentGlobalSlots: ReadonlyArray<number>;
	/** Source-immutable cells, plus captured lets with one named non-TDZ writer. */
	readonly singleAssignmentCapturedSlots: ReadonlyArray<CoreCapturedSlotRef>;
	/** Module bindings that no function except their writers can read uninitialized. */
	readonly initializedModuleGlobalSlots?: ReadonlyArray<number>;
	/**
	 * A module's lexical binding slots and every module that imports it through eager
	 * static edges. Outside import cycles those importers' functions only run after
	 * the module finished evaluating, so they never read one of its bindings empty.
	 */
	readonly importedModuleBindings?: ReadonlyArray<CoreImportedModuleBindings>;
	/** Other top-level module `var` slots: only Core stores write them, after `undefined`. */
	readonly moduleVarGlobalSlots?: ReadonlyArray<number>;
	/** Captured cells that a function can only read after their initialization. */
	readonly initializedCapturedReads?: ReadonlyArray<CoreInitializedCapturedRead>;
	/** Top-level lexical bindings that a function can only read after their initialization. */
	readonly initializedModuleBindingReads?: ReadonlyArray<CoreInitializedModuleBindingReads>;
	readonly retainedHostInstallers: ReadonlyArray<string>;
	/** Present only for an image of a relocatable program. */
	readonly moduleLinks?: CoreModuleLinks;
}

/**
 * One source file's top-level lexical binding slots in declaration order, and the
 * functions created only after the first `count` of them were initialized.
 */
export interface CoreInitializedModuleBindingReads {
	readonly slots: ReadonlyArray<number>;
	readonly functions: ReadonlyArray<{
		readonly function: number;
		readonly count: number;
	}>;
}

export interface CoreImportedModuleBindings {
	readonly slots: ReadonlyArray<number>;
	readonly importers: ReadonlyArray<string>;
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

const initializedGlobalSlotMembershipBySource = new WeakMap<
	ReadonlyArray<number>,
	ReadonlySet<number>
>();

export function coreInitializedGlobalSlotMembership(
	context: CoreCompilationContext,
): ReadonlySet<number> {
	const slots = context.data.initializedModuleGlobalSlots;
	if (slots === undefined) return new Set();
	let membership = initializedGlobalSlotMembershipBySource.get(slots);
	if (membership === undefined) {
		membership = new Set(slots);
		initializedGlobalSlotMembershipBySource.set(slots, membership);
	}
	return membership;
}

const importedModuleBindingReadersBySource = new WeakMap<
	ReadonlyArray<CoreImportedModuleBindings>,
	ReadonlyMap<number, ReadonlySet<string>>
>();

/** Whether a function from the module at `readerPath` always reads `slot` initialized. */
export function coreReadsImportedBindingInitialized(
	context: CoreCompilationContext,
	readerPath: string,
	slot: number,
): boolean {
	const bindings = context.data.importedModuleBindings;
	if (bindings === undefined) return false;
	let readers = importedModuleBindingReadersBySource.get(bindings);
	if (readers === undefined) {
		const map = new Map<number, ReadonlySet<string>>();
		for (const { slots, importers } of bindings) {
			const set = new Set(importers);
			for (const bindingSlot of slots) map.set(bindingSlot, set);
		}
		readers = map;
		importedModuleBindingReadersBySource.set(bindings, readers);
	}
	return readers.get(slot)?.has(readerPath) === true;
}

const initializedModuleBindingReadsBySource = new WeakMap<
	ReadonlyArray<CoreInitializedModuleBindingReads>,
	{
		readonly slotOrder: ReadonlyMap<
			number,
			{ readonly file: number; readonly order: number }
		>;
		readonly functionPrefix: ReadonlyMap<
			number,
			{ readonly file: number; readonly count: number }
		>;
	}
>();

/** Whether function `functionIndex` was created after its file initialized `slot`. */
export function coreReadsModuleBindingInitialized(
	context: CoreCompilationContext,
	functionIndex: number,
	slot: number,
): boolean {
	const reads = context.data.initializedModuleBindingReads;
	if (reads === undefined) return false;
	let index = initializedModuleBindingReadsBySource.get(reads);
	if (index === undefined) {
		const slotOrder = new Map<number, { file: number; order: number }>();
		const functionPrefix = new Map<number, { file: number; count: number }>();
		reads.forEach(({ slots, functions }, file) => {
			slots.forEach((bindingSlot, order) => slotOrder.set(bindingSlot, { file, order }));
			for (const { function: owner, count } of functions)
				functionPrefix.set(owner, { file, count });
		});
		index = { slotOrder, functionPrefix };
		initializedModuleBindingReadsBySource.set(reads, index);
	}
	const binding = index.slotOrder.get(slot);
	const prefix = index.functionPrefix.get(functionIndex);
	return (
		binding !== undefined &&
		prefix !== undefined &&
		binding.file === prefix.file &&
		binding.order < prefix.count
	);
}

/** Whether a function's reads of a module binding slot always find it initialized. */
export function coreReadsGlobalBindingInitialized(
	context: CoreCompilationContext,
	functionIndex: number,
	sourcePath: string,
	slot: number,
): boolean {
	return (
		coreReadsModuleBindingInitialized(context, functionIndex, slot) ||
		coreReadsImportedBindingInitialized(context, sourcePath, slot)
	);
}

const initializedCapturedReadMembershipBySource = new WeakMap<
	ReadonlyArray<CoreInitializedCapturedRead>,
	ReadonlySet<string>
>();

/** Keys `function:owner:index` of captured reads that cannot observe the TDZ. */
export function coreInitializedCapturedReadMembership(
	context: CoreCompilationContext,
): ReadonlySet<string> {
	const reads = context.data.initializedCapturedReads;
	if (reads === undefined) return new Set();
	let membership = initializedCapturedReadMembershipBySource.get(reads);
	if (membership === undefined) {
		membership = new Set(
			reads.map((read) => `${read.function}:${read.owner}:${read.index}`),
		);
		initializedCapturedReadMembershipBySource.set(reads, membership);
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
interface CapturedSlotScan {
	readonly bodyVersion: number;
	readonly slots: ReadonlyArray<CoreCapturedSlotRef>;
}

// Program-flow solves rerun this after every edit; unchanged bodies keep their scan.
const capturedSlotScans = new WeakMap<CoreFunctionStore, CapturedSlotScan>();

function capturedSlotsOf(fn: CoreFunctionStore): ReadonlyArray<CoreCapturedSlotRef> {
	// An open editor's edits move no version until it commits.
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = capturedSlotScans.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion)
		return cached.slots;
	const slots: Array<CoreCapturedSlotRef> = [];
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode !== "loadCaptured" && opcode !== "storeCaptured") continue;
		const attributes = fn.instructionAttributes(instruction);
		const owner = attributes.functionIndex;
		const index = attributes.index;
		if (typeof owner === "number" && typeof index === "number")
			slots.push({ owner, index });
	}
	if (bodyVersion !== undefined) capturedSlotScans.set(fn, { bodyVersion, slots });
	return slots;
}

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
	const retained = slots.filter((slot) => !mapped.get(slot.owner)?.has(slot.index));
	const seen = new Map<number, Set<number>>();
	for (const slot of retained) {
		const indices = seen.get(slot.owner) ?? new Set<number>();
		indices.add(slot.index);
		seen.set(slot.owner, indices);
	}
	for (const functionId of program.functionIds()) {
		for (const slot of capturedSlotsOf(program.function(functionId))) {
			if (mapped.get(slot.owner)?.has(slot.index)) continue;
			const indices = seen.get(slot.owner) ?? new Set<number>();
			if (indices.has(slot.index)) continue;
			indices.add(slot.index);
			seen.set(slot.owner, indices);
			retained.push(slot);
		}
	}
	return retained;
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
