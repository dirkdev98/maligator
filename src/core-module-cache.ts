import { hash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { compilerProducerIdentity } from "./compiler-cache-identity.ts";
import { lowerSemanticProgramToCore } from "./compiler/core/core-frontend.ts";
import { CoreLocalOptimizer } from "./compiler/core/core-local-optimizer.ts";
import {
	captureCoreModule,
	decodeCoreModule,
	encodeCoreModule,
	UnsupportedCoreModuleError,
	CORE_MODULE_MAX_ENCODED_LENGTH,
} from "./compiler/core/core-module-artifact.ts";
import type { CoreModuleArtifact } from "./compiler/core/core-module-artifact.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { ModuleRecord } from "./compiler/frontend/module-graph.ts";
import { parseModule } from "./compiler/frontend/parser.ts";
import { conservativeCompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";

const BOUNDARY = "strict-esm-private-cells-boxed-local-v3";
const RECIPE = "conservative-local-v1";
export interface CoreModuleCacheOptions {
	source: string;
	sourcePath: string;
	moduleKey: string;
	cacheDirectory: string;
	maxWorkItems?: number;
	maxEdits?: number;
	onWork?: (phase: "construct" | "optimize", functions: number) => void;
	/** The parsed tree must correspond to source under this stripping/transform producer. */
	parsed?: { result: ModuleRecord["parsed"]; producer: string };
}
export type CoreModuleCacheResult =
	| {
			status: "ready";
			cache: "hit" | "miss";
			canonical: CoreModuleArtifact;
			optimized: CoreModuleArtifact;
			completedRecipe: typeof RECIPE;
			key: string;
			work: { constructedFunctions: number; optimizedFunctions: number };
	  }
	| { status: "unsupported" | "budget-limited"; reason: string };
interface ModuleReceipt {
	schema: 1;
	key: string;
	canonical: string;
	optimized: string;
	canonicalDigest: string;
	optimizedDigest: string;
}
interface UnsupportedReceipt {
	schema: 1;
	key: string;
	unsupported: string;
	status: "unsupported" | "budget-limited";
}
class CoreModuleBudgetError extends Error {}
function digest(text: string) {
	return hash("sha256", text, "hex");
}
function rejectUnsupportedSyntax(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) rejectUnsupportedSyntax(item);
		return;
	}
	const node = value as Record<string, unknown>;
	if (
		[
			"ImportDeclaration",
			"ImportExpression",
			"ExportAllDeclaration",
			"WithStatement",
			"AwaitExpression",
			"YieldExpression",
			"TaggedTemplateExpression",
		].includes(String(node.type)) ||
		node.async === true ||
		node.generator === true ||
		(node.type === "ExportNamedDeclaration" &&
			node.source !== null &&
			node.source !== undefined)
	)
		throw new UnsupportedCoreModuleError(
			`Unsupported reusable Core syntax: ${String(node.type)}`,
		);
	for (const child of Object.values(node)) rejectUnsupportedSyntax(child);
}

function publishReceipt(file: string, receipt: ModuleReceipt | UnsupportedReceipt): void {
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(temporary, JSON.stringify(receipt), { flag: "wx" });
		renameSync(temporary, file);
	} catch (error) {
		// Optional persistence must not turn a valid build into a cache-permission failure.
		if (!(error instanceof Error) || !("code" in error)) throw error;
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* A failed publication may leave no writable directory. */
		}
	}
}

/** Callers import the selected variant and invoke its initializer before reading live exports. */
export function loadOrCompileCoreModule(
	options: CoreModuleCacheOptions,
): CoreModuleCacheResult {
	const maxWorkItems = options.maxWorkItems ?? 100_000;
	const maxEdits = options.maxEdits ?? 100_000;
	const key = digest(
		JSON.stringify({
			schema: 1,
			boundary: BOUNDARY,
			recipe: RECIPE,
			producer: compilerProducerIdentity("core-module", 1),
			module: options.moduleKey,
			source: digest(JSON.stringify(options.source)),
			maxWorkItems,
			maxEdits,
			parser: options.parsed?.producer,
		}),
	);
	const file = path.join(options.cacheDirectory, `${key}.json`);
	try {
		const receipt = JSON.parse(readFileSync(file, "utf8")) as
			| ModuleReceipt
			| UnsupportedReceipt;
		if (
			receipt.schema === 1 &&
			receipt.key === key &&
			"unsupported" in receipt &&
			typeof receipt.unsupported === "string"
		)
			return {
				status: receipt.status === "budget-limited" ? "budget-limited" : "unsupported",
				reason: receipt.unsupported,
			};
		if (
			!("unsupported" in receipt) &&
			receipt.schema === 1 &&
			receipt.key === key &&
			digest(receipt.canonical) === receipt.canonicalDigest &&
			digest(receipt.optimized) === receipt.optimizedDigest
		) {
			const optimized = decodeCoreModule(receipt.optimized);
			return {
				status: "ready",
				cache: "hit",
				get canonical() {
					return decodeCoreModule(receipt.canonical);
				},
				optimized,
				completedRecipe: RECIPE,
				key,
				work: { constructedFunctions: 0, optimizedFunctions: 0 },
			};
		}
	} catch {
		/* An unusable cache entry is a miss; destination Core has not been touched. */
	}
	try {
		const parsed = options.parsed?.result ?? parseModule(options.source);
		rejectUnsupportedSyntax(parsed.ast);
		const graph =
			options.parsed === undefined
				? buildModuleGraph(options.sourcePath, {
						entrySource: options.source,
						entryGoal: "module",
						stripTypes: (source) => source,
					})
				: {
						entry: options.sourcePath,
						nodeEnabled: false,
						modules: new Map([
							[
								options.sourcePath,
								{
									path: options.sourcePath,
									goal: "module" as const,
									source: options.source,
									parsed,
									dependencies: [],
								},
							],
						]),
						evaluationOrder: [options.sourcePath],
						cycles: [],
					};
		if (
			graph.modules.size !== 1 ||
			[...graph.modules.values()].some((module) => module.dependencies.length !== 0)
		)
			throw new UnsupportedCoreModuleError(
				"Reusable Core pilot requires one import-free module",
			);
		const core = lowerSemanticProgramToCore(runSemanticAnalysisForGraph(graph), {
			facts: conservativeCompilerProgramFacts(),
			captureModuleExports: true,
		});
		const functions = [...core.program.functionIds()];
		options.onWork?.("construct", functions.length);
		const exports = (core.context.data.moduleExports ?? []).map(({ name, slot }) => ({
			name,
			slot,
		}));
		const canonical = captureCoreModule(
			core.program,
			exports,
			functions[0]!,
			core.context.data,
		);
		for (const fn of functions) {
			options.onWork?.("optimize", 1);
			const result = new CoreLocalOptimizer(core.program, fn, {
				maxWorkItems,
				maxEdits,
				budgetExhaustion: "stop",
			}).run();
			if (result.statistics.workBudgetExhausted || result.statistics.editBudgetExhausted)
				throw new CoreModuleBudgetError(
					"Reusable Core scalar recipe exceeded its work budget",
				);
		}
		const optimized = captureCoreModule(
			core.program,
			exports,
			functions[0]!,
			core.context.data,
		);
		const canonicalBytes = encodeCoreModule(canonical);
		const optimizedBytes = encodeCoreModule(optimized);
		if (
			canonicalBytes.length > CORE_MODULE_MAX_ENCODED_LENGTH ||
			optimizedBytes.length > CORE_MODULE_MAX_ENCODED_LENGTH
		)
			throw new UnsupportedCoreModuleError(
				"Reusable Core exceeds the artifact size limit",
			);
		const receipt: ModuleReceipt = {
			schema: 1,
			key,
			canonical: canonicalBytes,
			optimized: optimizedBytes,
			canonicalDigest: digest(canonicalBytes),
			optimizedDigest: digest(optimizedBytes),
		};
		publishReceipt(file, receipt);
		return {
			status: "ready",
			cache: "miss",
			canonical,
			optimized,
			completedRecipe: RECIPE,
			key,
			work: {
				constructedFunctions: functions.length,
				optimizedFunctions: functions.length,
			},
		};
	} catch (error) {
		if (
			error instanceof UnsupportedCoreModuleError ||
			error instanceof CoreModuleBudgetError
		) {
			const status =
				error instanceof CoreModuleBudgetError ? "budget-limited" : "unsupported";
			publishReceipt(file, { schema: 1, key, unsupported: error.message, status });
			return { status, reason: error.message };
		}
		throw error;
	}
}
