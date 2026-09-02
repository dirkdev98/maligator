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
	readonly versionKey: string;
	readonly value: unknown;
}

interface RegisteredAnalysis {
	readonly signature: string;
}

function selectedVersions<Domain extends string>(
	versions: Readonly<Record<Domain, number>>,
	dependencies: ReadonlyArray<Domain>,
): string {
	return dependencies.map((domain) => `${domain}:${versions[domain]}`).join(",");
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
		const versionKey = this.#versionKey(definition, request);
		const cached = this.#cache.get(cacheKey);
		if (cached?.versionKey === versionKey) {
			this.#report.recordAnalysis(definition.key, "hit", false, 0);
			return cached.value as Result;
		}
		const startedAt = Date.now();
		const value = definition.compute({
			program: this.#program,
			context: this.#context,
			request,
			get: (dependency, dependencyRequest) => this.get(dependency, dependencyRequest),
			...(cached === undefined ? {} : { previous: cached.value }),
		});
		this.#cache.set(cacheKey, { versionKey, value });
		this.#report.recordAnalysis(
			definition.key,
			"recompute",
			cached !== undefined,
			Date.now() - startedAt,
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

	#versionKey<Result>(
		definition: CoreAnalysisDefinition<Result>,
		request: CoreAnalysisRequest,
	): string {
		const functionDependencies = definition.functionDependencies ?? [];
		const programDependencies = definition.programDependencies ?? [];
		const contextIdentity = definition.contextIdentity?.(this.#context) ?? "";
		const programVersions = selectedVersions<CoreProgramChangeDomain>(
			this.#program.versions,
			programDependencies,
		);
		let functionVersions = "";
		if (request.scope === "function") {
			functionVersions = selectedVersions<CoreChangeDomain>(
				this.#program.function(request.function).versions,
				functionDependencies,
			);
		} else if (request.scope === "scc") {
			functionVersions = sortedFunctions(request.functions)
				.map((functionId) => {
					const versions = selectedVersions<CoreChangeDomain>(
						this.#program.function(functionId).versions,
						functionDependencies,
					);
					return `${functionId}[${versions}]`;
				})
				.join(";");
		} else if (functionDependencies.length > 0) {
			functionVersions = [...this.#program.functionIds()]
				.map((functionId) => {
					const versions = selectedVersions<CoreChangeDomain>(
						this.#program.function(functionId).versions,
						functionDependencies,
					);
					return `${functionId}[${versions}]`;
				})
				.join(";");
		}
		return `${contextIdentity}\0${programVersions}\0${functionVersions}`;
	}
}
