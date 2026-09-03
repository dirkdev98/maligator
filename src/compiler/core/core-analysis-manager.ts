import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreChangeDomain,
	CoreProgram,
	CoreProgramChangeDomain,
} from "./core-store.ts";

export type CoreAnalysisScope = "function" | "scc" | "program";

export type CoreAnalysisRequest =
	| { readonly scope: "function"; readonly function: CoreFunctionId }
	| {
			readonly scope: "scc";
			readonly index: number;
			readonly id: string;
			readonly functions: ReadonlyArray<CoreFunctionId>;
	  }
	| { readonly scope: "program" };

export interface CoreAnalysisComputation {
	readonly program: CoreProgram;
	readonly context: CoreCompilationContext;
	readonly request: CoreAnalysisRequest;
	readonly previous?: unknown;
	readonly programFlow: CoreProgramFlowEngine;
	readonly get: <Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	) => Result;
}

export interface CoreAnalysisDefinition<Result> {
	readonly key: string;
	readonly scope: CoreAnalysisScope;
	readonly functionDependencies?: ReadonlyArray<CoreChangeDomain>;
	readonly programDependencies?: ReadonlyArray<CoreProgramChangeDomain>;
	readonly contextIdentity?: (context: CoreCompilationContext) => unknown;
	readonly compute: (input: CoreAnalysisComputation) => Result;
}

interface CachedAnalysis {
	readonly contextIdentity: unknown;
	readonly programVersions: ReadonlyArray<number>;
	readonly functionVersions: ReadonlyArray<number>;
	readonly value: unknown;
}

interface DefinitionCache {
	program?: CachedAnalysis;
	readonly functions: Array<CachedAnalysis | undefined>;
	readonly sccs: Array<CachedAnalysis | undefined>;
}

interface RegisteredAnalysis {
	readonly scope: CoreAnalysisScope;
	readonly functionDependencies: ReadonlyArray<CoreChangeDomain>;
	readonly programDependencies: ReadonlyArray<CoreProgramChangeDomain>;
}

function sameValues<Value>(
	left: ReadonlyArray<Value>,
	right: ReadonlyArray<Value>,
): boolean {
	return (
		left.length === right.length && left.every((value, index) => value === right[index])
	);
}

function sortedFunctions(
	functions: ReadonlyArray<CoreFunctionId>,
): Array<CoreFunctionId> {
	return [...new Set(functions)].sort((left, right) => left - right);
}

export class CoreAnalysisManager {
	readonly #program: CoreProgram;
	readonly #generation: number;
	readonly #context: CoreCompilationContext;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #programFlow: CoreProgramFlowEngine;
	readonly #cache = new WeakMap<CoreAnalysisDefinition<unknown>, DefinitionCache>();
	readonly #contextIdentities = new WeakMap<CoreAnalysisDefinition<unknown>, unknown>();
	readonly #registered = new Map<string, RegisteredAnalysis>();
	readonly #validatedDefinitions = new WeakSet<CoreAnalysisDefinition<unknown>>();
	readonly #timingStarts: Array<number> = [];
	readonly #timingNested: Array<number> = [];
	#timingDepth = 0;

	constructor(
		program: CoreProgram,
		context: CoreCompilationContext,
		report: CoreOptimizationReportBuilder,
	) {
		this.#program = program;
		this.#generation = program.generation;
		this.#context = context;
		this.#report = report;
		this.#programFlow = new CoreProgramFlowEngine(program, report);
	}

	get<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): Result {
		if (this.#program.generation !== this.#generation) {
			throw new Error(
				`Core analysis manager belongs to retired generation ${this.#generation}`,
			);
		}
		this.#validateDefinition(definition, request);
		const definitionCache = this.#cache.get(definition) ?? {
			functions: [],
			sccs: [],
		};
		this.#cache.set(definition, definitionCache);
		const cached =
			request.scope === "program"
				? definitionCache.program
				: request.scope === "function"
					? definitionCache.functions[request.function]
					: definitionCache.sccs[request.index];
		if (cached !== undefined && this.#versionsMatch(definition, request, cached)) {
			this.#report.recordAnalysis(definition.key, "hit", false, 0);
			return cached.value as Result;
		}
		const versions = this.#captureVersions(definition, request);
		const timesAnalysis = this.#report.timesAnalysis(definition.key);
		const timingDepth = this.#timingDepth;
		if (timesAnalysis) {
			this.#timingDepth++;
			this.#timingStarts[timingDepth] = Date.now();
			this.#timingNested[timingDepth] = 0;
		}
		let value: Result;
		let elapsedMs = 0;
		try {
			value = definition.compute({
				program: this.#program,
				context: this.#context,
				request,
				programFlow: this.#programFlow,
				get: (dependency, dependencyRequest) => this.get(dependency, dependencyRequest),
				...(cached === undefined ? {} : { previous: cached.value }),
			});
		} finally {
			if (timesAnalysis) {
				const totalMs = Date.now() - this.#timingStarts[timingDepth]!;
				elapsedMs = Math.max(0, totalMs - this.#timingNested[timingDepth]!);
				this.#timingDepth--;
				if (timingDepth > 0) {
					this.#timingNested[timingDepth - 1] =
						this.#timingNested[timingDepth - 1]! + totalMs;
				}
			}
		}
		const next = { ...versions, value };
		if (request.scope === "program") definitionCache.program = next;
		else if (request.scope === "function") {
			definitionCache.functions[request.function] = next;
		} else definitionCache.sccs[request.index] = next;
		this.#report.recordAnalysisResult(definition.key, value);
		this.#report.recordAnalysis(
			definition.key,
			"recompute",
			cached !== undefined,
			elapsedMs,
		);
		return value;
	}

	#validateDefinition<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): void {
		if (definition.key.length === 0) throw new Error("Core analysis key is empty");
		if (definition.scope !== request.scope) {
			throw new Error(
				`Core analysis ${definition.key} requires ${definition.scope} scope, received ${request.scope}`,
			);
		}
		if (this.#validatedDefinitions.has(definition)) return;
		const functionDependencies = definition.functionDependencies ?? [];
		const programDependencies = definition.programDependencies ?? [];
		if (definition.scope === "program" && programDependencies.length === 0) {
			throw new Error(
				`Program analysis ${definition.key} must declare an explicit program dependency`,
			);
		}
		const registered = this.#registered.get(definition.key);
		if (
			registered !== undefined &&
			(registered.scope !== definition.scope ||
				!sameValues(registered.functionDependencies, functionDependencies) ||
				!sameValues(registered.programDependencies, programDependencies))
		) {
			throw new Error(`Core analysis key ${definition.key} has conflicting dependencies`);
		}
		this.#registered.set(definition.key, {
			scope: definition.scope,
			functionDependencies: [...functionDependencies],
			programDependencies: [...programDependencies],
		});
		this.#validatedDefinitions.add(definition);
	}

	#captureVersions<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): Omit<CachedAnalysis, "value"> {
		const functionDependencies = definition.functionDependencies ?? [];
		const programDependencies = definition.programDependencies ?? [];
		const contextIdentity = this.#contextIdentity(definition);
		const programVersions = programDependencies.map((domain) =>
			this.#program.programVersion(domain),
		);
		const functionVersions: Array<number> = [];
		const captureFunction = (functionId: CoreFunctionId): void => {
			const fn = this.#program.function(functionId);
			for (const domain of functionDependencies) {
				functionVersions.push(fn.version(domain));
			}
		};
		if (request.scope === "function") {
			captureFunction(request.function);
		} else if (request.scope === "scc") {
			for (const functionId of sortedFunctions(request.functions)) {
				captureFunction(functionId);
			}
		} else {
			for (const domain of functionDependencies) {
				functionVersions.push(this.#program.functionVersion(domain));
			}
		}
		return { contextIdentity, programVersions, functionVersions };
	}

	#versionsMatch<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
		cached: CachedAnalysis,
	): boolean {
		if (this.#contextIdentity(definition) !== cached.contextIdentity) {
			return false;
		}
		const programDependencies = definition.programDependencies ?? [];
		if (programDependencies.length !== cached.programVersions.length) return false;
		for (const [index, domain] of programDependencies.entries()) {
			if (this.#program.programVersion(domain) !== cached.programVersions[index])
				return false;
		}
		const functionDependencies = definition.functionDependencies ?? [];
		let versionIndex = 0;
		const functionMatches = (functionId: CoreFunctionId): boolean => {
			const fn = this.#program.function(functionId);
			for (const domain of functionDependencies) {
				if (fn.version(domain) !== cached.functionVersions[versionIndex++]) return false;
			}
			return true;
		};
		if (request.scope === "function") {
			if (!functionMatches(request.function)) return false;
		} else if (request.scope === "scc") {
			for (const functionId of sortedFunctions(request.functions)) {
				if (!functionMatches(functionId)) return false;
			}
		} else {
			for (const domain of functionDependencies) {
				if (
					this.#program.functionVersion(domain) !==
					cached.functionVersions[versionIndex++]
				)
					return false;
			}
		}
		return versionIndex === cached.functionVersions.length;
	}

	#contextIdentity<Result>(definition: CoreAnalysisDefinition<Result>): unknown {
		if (this.#contextIdentities.has(definition)) {
			return this.#contextIdentities.get(definition);
		}
		const identity = definition.contextIdentity?.(this.#context);
		this.#contextIdentities.set(definition, identity);
		return identity;
	}
}
