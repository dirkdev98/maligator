import { hash } from "node:crypto";
import type {
	EffectKind,
	FunctionEffectSummary,
	ModuleEffectSummary,
} from "./compiler-facts.ts";
import { encodeDirectEvalContext } from "./direct-eval-context.ts";
import { analyzeProgramEscape } from "./escape.ts";
import type { IntermediateProgram, IRFunction } from "./ir.ts";
import { MALIGATOR_VERSION } from "./version.ts";

const SUMMARY_ANALYSIS_VERSION = 2;
const MAX_CACHED_PROGRAMS = 64;

export interface SharedProgramSummaries {
	readonly cacheIdentity: string;
	readonly functionEffects: ReadonlyMap<string, FunctionEffectSummary>;
	readonly moduleEffects: ReadonlyMap<string, ModuleEffectSummary>;
}

const summaryCache = new Map<string, SharedProgramSummaries>();
const localSummaries = new WeakMap<IntermediateProgram, SharedProgramSummaries>();

/** Only facts that can change these summaries participate in invalidation. */
export function compilerSummaryCacheIdentity(program: IntermediateProgram): string {
	const world = program.facts.world;
	const source = program.semantic.files
		.map((file) => ({ path: file.path, contents: file.contents, goal: file.type }))
		.sort((left, right) => left.path.localeCompare(right.path));
	const graph = program.semantic.graph;
	const moduleGraph =
		graph === undefined
			? undefined
			: {
					nodeEnabled: graph.nodeEnabled,
					evaluationOrder: graph.evaluationOrder,
					cycles: graph.cycles,
					modules: [...graph.modules.values()]
						.map((module) => ({
							path: module.path,
							goal: module.goal,
							dependencies: module.dependencies.map((dependency) => ({
								specifier: dependency.specifier,
								resolvedPath: dependency.resolvedPath,
							})),
							host:
								module.host === undefined
									? undefined
									: {
											id: module.host.id,
											named: module.host.named,
											hasDefault: module.host.hasDefault,
											installer: module.host.installer,
										},
						}))
						.sort((left, right) => left.path.localeCompare(right.path)),
				};
	return hash(
		"sha256",
		JSON.stringify({
			compiler: MALIGATOR_VERSION,
			analysis: SUMMARY_ANALYSIS_VERSION,
			entrypoint: program.semantic.entrypointPath,
			evalCompletion: program.evalCompletion,
			evalDirect: program.evalDirect,
			directEvalContext: encodeDirectEvalContext(program.directEvalContext),
			compilationMode: program.facts.compilationMode,
			world: {
				primordials: world.primordialPolicy,
				eval: world.eval,
				realms: world.realms,
				sourceClosure:
					world.sourceClosure.kind === "known"
						? world.sourceClosure.value
						: world.sourceClosure.reason,
			},
			moduleGraph,
			source,
		}),
		"hex",
	);
}

function functionId(fn: IRFunction): string {
	return `${encodeURIComponent(fn.semanticFile.path)}#${fn.functionIndex}`;
}

function directCallees(fn: IRFunction): { callees: Array<number>; unknown: boolean } {
	const callees = new Set<number>();
	let unknown = false;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type !== "call" && instruction.type !== "construct") continue;
			// Existing direct-call annotations are guarded candidates with a generic
			// fallback, not unconditional target-set proofs.
			unknown = true;
			const direct = instruction.directFunctionIndex;
			const shifted =
				instruction.type === "call"
					? instruction.directCallTargetFunctionIndex
					: undefined;
			if (direct !== undefined) callees.add(direct);
			else if (shifted !== undefined) callees.add(shifted);
		}
	}
	return { callees: [...callees].sort((left, right) => left - right), unknown };
}

function collectInstructionEffects(fn: IRFunction): Set<EffectKind> {
	const effects = new Set<EffectKind>();
	const propertyReads = new Set([
		"loadProperty",
		"loadPropertyStatic",
		"loadSuperProperty",
		"loadPrototype",
		"hasPrivate",
		"loadPrivate",
	]);
	const propertyWrites = new Set([
		"storeProperty",
		"storePropertyStatic",
		"storeSuperProperty",
		"mergeDataProperties",
		"deleteProperty",
		"defineAccessor",
		"defineProperty",
		"definePrivate",
		"initPrivateFields",
		"storePrivate",
		"setPrototype",
		"copyDataProperties",
	]);
	const coercions = new Set([
		"toPropertyKey",
		"requireCoercible",
		"binary",
		"unary",
		"typeofCompare",
		"checkSuperClass",
	]);
	const userDispatch = new Set([
		"call",
		"construct",
		"callSpread",
		"callSpreadIterable",
		"constructSpread",
		"constructSuper",
		"constructSuperExplicit",
		"getIterator",
		"getAsyncIterator",
		"iteratorNext",
		"iteratorStep",
		"iteratorClose",
		"forInKeys",
	]);

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const type = instruction.type;
			if (type === "loadGlobalProperty" || type === "loadGlobal") {
				effects.add("read-global");
			}
			if (
				type === "storeGlobalProperty" ||
				type === "storeGlobal" ||
				type === "initGlobalVars"
			) {
				effects.add("write-global");
			}
			if (type === "loadGlobalProperty") {
				effects.add("property-access");
				effects.add("read-prototype");
				effects.add("call-user-code");
				effects.add("throw");
			}
			if (type === "storeGlobalProperty") {
				effects.add("property-access");
				effects.add("write-prototype");
				effects.add("call-user-code");
				effects.add("throw");
			}
			if (propertyReads.has(type)) {
				effects.add("property-access");
				effects.add("read-prototype");
				effects.add("call-user-code");
				effects.add("throw");
			}
			if (propertyWrites.has(type)) {
				effects.add("property-access");
				effects.add("write-prototype");
				effects.add("call-user-code");
				effects.add("throw");
			}
			if (coercions.has(type)) {
				effects.add("coerce");
				effects.add("call-user-code");
				effects.add("throw");
			}
			if (userDispatch.has(type)) {
				effects.add("call-user-code");
				effects.add("unknown-call");
				effects.add("throw");
				effects.add("safepoint");
			}
			if (type === "await" || type === "yield" || type === "asyncStart") {
				effects.add("suspend");
				effects.add("safepoint");
			}
			if (type === "throw" || type === "loadUndeclared" || type === "throwIfTdz") {
				effects.add("throw");
			}
			if (
				type === "withEnter" ||
				type === "withGet" ||
				type === "withResolveBase" ||
				type === "withSet"
			) {
				effects.add("eval-visible");
				effects.add("property-access");
				effects.add("call-user-code");
			}
		}
	}
	return effects;
}

function computeSummaries(program: IntermediateProgram): SharedProgramSummaries {
	const identity = compilerSummaryCacheIdentity(program);
	const escape = analyzeProgramEscape(program);
	const functionByIndex = new Map(program.functions.map((fn) => [fn.functionIndex, fn]));
	const functionEffects = new Map<string, FunctionEffectSummary>();

	for (const fn of program.functions) {
		const escapeSummary = escape.summaries.get(fn.functionIndex)!;
		const targets = directCallees(fn);
		const effects = collectInstructionEffects(fn);
		if (escapeSummary.allocates) effects.add("allocate");
		if (escapeSummary.mayThrow) effects.add("throw");
		if (escapeSummary.mayGC) effects.add("safepoint");
		if (targets.unknown) effects.add("unknown-call");
		if (fn.semanticFile.hasDirectEval.size > 0) effects.add("eval-visible");
		functionEffects.set(functionId(fn), {
			id: functionId(fn),
			effects: [...effects].sort(),
			callees: targets.callees
				.map((index) => functionByIndex.get(index))
				.filter((callee): callee is IRFunction => callee !== undefined)
				.map(functionId),
			// Until callable-target/identity escape is shared, retain all functions.
			externallyReachable: true,
			parameterEscape: [...escapeSummary.params],
			restParameterEscape: escapeSummary.restParam,
			receiverEscape: escapeSummary.receiver,
			returnProvenance: escapeSummary.returnProvenance,
		});
	}

	// Effects flow monotonically through the known call graph. Escape propagation
	// itself remains owned by analyzeProgramEscape's existing fixed-point engine.
	let changed = true;
	while (changed) {
		changed = false;
		for (const summary of functionEffects.values()) {
			const effects = new Set(summary.effects);
			for (const callee of summary.callees) {
				for (const effect of functionEffects.get(callee)?.effects ?? [])
					effects.add(effect);
			}
			const next = [...effects].sort();
			if (next.join("\0") !== summary.effects.join("\0")) {
				functionEffects.set(summary.id, { ...summary, effects: next });
				changed = true;
			}
		}
	}

	const moduleEffects = new Map<string, ModuleEffectSummary>();
	for (const file of program.semantic.files) {
		const functions = [...functionEffects.values()].filter((summary) =>
			summary.id.startsWith(`${encodeURIComponent(file.path)}#`),
		);
		moduleEffects.set(file.path, {
			id: file.path,
			effects: [...new Set(functions.flatMap(({ effects }) => effects))].sort(),
			functions: functions.map(({ id }) => id).sort(),
			// Export/host root identities are not shared yet, so retain every module.
			externallyReachable: true,
		});
	}

	return { cacheIdentity: identity, functionEffects, moduleEffects };
}

/** Lazily compute once, then share across passes and equivalent compilation sessions. */
export function ensureCompilerSummaries(
	program: IntermediateProgram,
): SharedProgramSummaries {
	const local = localSummaries.get(program);
	if (local !== undefined) return local;
	const identity = compilerSummaryCacheIdentity(program);
	let summaries = summaryCache.get(identity);
	if (summaries === undefined) {
		summaries = computeSummaries(program);
		summaryCache.set(identity, summaries);
		if (summaryCache.size > MAX_CACHED_PROGRAMS) {
			summaryCache.delete(summaryCache.keys().next().value!);
		}
	}
	localSummaries.set(program, summaries);
	program.facts = {
		...program.facts,
		functionEffects: summaries.functionEffects,
		moduleEffects: summaries.moduleEffects,
	};
	return summaries;
}
