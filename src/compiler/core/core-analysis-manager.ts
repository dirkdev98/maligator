import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
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
			readonly id: string;
			readonly functions: ReadonlyArray<CoreFunctionId>;
	  }
	| { readonly scope: "program" };

export interface CoreAnalysisComputation {
	readonly program: CoreProgram;
	readonly context: CoreCompilationContext;
	readonly request: CoreAnalysisRequest;
	readonly previous?: unknown;
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
	readonly contextIdentity?: (context: CoreCompilationContext) => string;
	readonly compute: (input: CoreAnalysisComputation) => Result;
}

interface CachedAnalysis {
	readonly contextIdentity: string;
	readonly programVersions: ReadonlyArray<number>;
	readonly functionVersions: ReadonlyArray<number>;
	readonly value: unknown;
}

interface RegisteredAnalysis {
	readonly signature: string;
}

function sortedFunctions(
	functions: ReadonlyArray<CoreFunctionId>,
): Array<CoreFunctionId> {
	return [...new Set(functions)].sort((left, right) => left - right);
}

export class CoreAnalysisManager {
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #cache = new Map<string, CachedAnalysis>();
	readonly #registered = new Map<string, RegisteredAnalysis>();
	readonly #validatedDefinitions = new WeakSet<CoreAnalysisDefinition<unknown>>();

	constructor(
		program: CoreProgram,
		context: CoreCompilationContext,
		report: CoreOptimizationReportBuilder,
	) {
		this.#program = program;
		this.#context = context;
		this.#report = report;
	}

	get<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): Result {
		this.#validateDefinition(definition, request);
		const cacheKey = `${definition.key}\0${this.#scopeKey(request)}`;
		const cached = this.#cache.get(cacheKey);
		if (cached !== undefined && this.#versionsMatch(definition, request, cached)) {
			this.#report.recordAnalysis(definition.key, "hit", false, 0);
			return cached.value as Result;
		}
		const versions = this.#captureVersions(definition, request);
		const startedAt = this.#report.collectsDetails ? Date.now() : 0;
		const value = definition.compute({
			program: this.#program,
			context: this.#context,
			request,
			get: (dependency, dependencyRequest) => this.get(dependency, dependencyRequest),
			...(cached === undefined ? {} : { previous: cached.value }),
		});
		this.#cache.set(cacheKey, { ...versions, value });
		this.#report.recordAnalysis(
			definition.key,
			"recompute",
			cached !== undefined,
			this.#report.collectsDetails ? Date.now() - startedAt : 0,
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
		const signature = JSON.stringify({
			scope: definition.scope,
			functionDependencies,
			programDependencies,
		});
		const registered = this.#registered.get(definition.key);
		if (registered !== undefined && registered.signature !== signature) {
			throw new Error(`Core analysis key ${definition.key} has conflicting dependencies`);
		}
		this.#registered.set(definition.key, { signature });
		this.#validatedDefinitions.add(definition);
	}

	#scopeKey(request: CoreAnalysisRequest): string {
		switch (request.scope) {
			case "function":
				return `function:${request.function}`;
			case "scc":
				return `scc:${request.id}:${sortedFunctions(request.functions).join(",")}`;
			case "program":
				return "program";
		}
	}

	#captureVersions<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): Omit<CachedAnalysis, "value"> {
		const functionDependencies = definition.functionDependencies ?? [];
		const programDependencies = definition.programDependencies ?? [];
		const contextIdentity = definition.contextIdentity?.(this.#context) ?? "";
		const programVersions = programDependencies.map(
			(domain) => this.#program.versions[domain],
		);
		const functionVersions: Array<number> = [];
		const captureFunction = (functionId: CoreFunctionId): void => {
			const versions = this.#program.function(functionId).versions;
			for (const domain of functionDependencies) {
				functionVersions.push(versions[domain]);
			}
		};
		if (request.scope === "function") {
			captureFunction(request.function);
		} else if (request.scope === "scc") {
			for (const functionId of sortedFunctions(request.functions)) {
				captureFunction(functionId);
			}
		} else if (functionDependencies.length > 0) {
			for (const functionId of this.#program.functionIds()) captureFunction(functionId);
		}
		return { contextIdentity, programVersions, functionVersions };
	}

	#versionsMatch<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
		cached: CachedAnalysis,
	): boolean {
		if ((definition.contextIdentity?.(this.#context) ?? "") !== cached.contextIdentity) {
			return false;
		}
		const programDependencies = definition.programDependencies ?? [];
		if (programDependencies.length !== cached.programVersions.length) return false;
		for (const [index, domain] of programDependencies.entries()) {
			if (this.#program.versions[domain] !== cached.programVersions[index]) return false;
		}
		const functionDependencies = definition.functionDependencies ?? [];
		let versionIndex = 0;
		const functionMatches = (functionId: CoreFunctionId): boolean => {
			const versions = this.#program.function(functionId).versions;
			for (const domain of functionDependencies) {
				if (versions[domain] !== cached.functionVersions[versionIndex++]) return false;
			}
			return true;
		};
		if (request.scope === "function") {
			if (!functionMatches(request.function)) return false;
		} else if (request.scope === "scc") {
			for (const functionId of sortedFunctions(request.functions)) {
				if (!functionMatches(functionId)) return false;
			}
		} else if (functionDependencies.length > 0) {
			for (const functionId of this.#program.functionIds()) {
				if (!functionMatches(functionId)) return false;
			}
		}
		return versionIndex === cached.functionVersions.length;
	}
}
