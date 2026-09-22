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
} from "./compiler/core/core-module-artifact.ts";
import type { CoreModuleArtifact } from "./compiler/core/core-module-artifact.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { parseModule } from "./compiler/frontend/parser.ts";
import { conservativeCompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";

const BOUNDARY = "strict-esm-private-globals-boxed-local-v1";
const RECIPE = "conservative-local-v1";
export interface CoreModuleCacheOptions {
	source: string;
	sourcePath: string;
	moduleKey: string;
	cacheDirectory: string;
	maxWorkItems?: number;
	maxEdits?: number;
	onWork?: (phase: "construct" | "optimize", functions: number) => void;
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
	| { status: "unsupported"; reason: string };
interface ModuleReceipt {
	schema: 1;
	key: string;
	canonical: string;
	optimized: string;
	canonicalDigest: string;
	optimizedDigest: string;
}
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
			"ClassDeclaration",
			"ClassExpression",
			"AwaitExpression",
			"YieldExpression",
			"TaggedTemplateExpression",
			"TemplateLiteral",
		].includes(String(node.type)) ||
		node.async === true ||
		node.generator === true ||
		(node.type === "ExportNamedDeclaration" &&
			node.source !== null &&
			node.source !== undefined)
	)
		throw new UnsupportedCoreModuleError(
			"Reusable Core pilot excludes imports, classes, suspension, templates and dynamic scopes",
		);
	for (const child of Object.values(node)) rejectUnsupportedSyntax(child);
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
		}),
	);
	const file = path.join(options.cacheDirectory, `${key}.json`);
	try {
		const receipt = JSON.parse(readFileSync(file, "utf8")) as ModuleReceipt;
		if (
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
		const parsed = parseModule(options.source);
		rejectUnsupportedSyntax(parsed.ast);
		const graph = buildModuleGraph(options.sourcePath, {
			entrySource: options.source,
			entryGoal: "module",
		});
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
		const canonical = captureCoreModule(core.program, exports, functions[0]!);
		for (const fn of functions)
			new CoreLocalOptimizer(core.program, fn, {
				maxWorkItems,
				maxEdits,
				budgetExhaustion: "error",
			}).run();
		options.onWork?.("optimize", functions.length);
		const optimized = captureCoreModule(core.program, exports, functions[0]!);
		const canonicalBytes = encodeCoreModule(canonical);
		const optimizedBytes = encodeCoreModule(optimized);
		const receipt: ModuleReceipt = {
			schema: 1,
			key,
			canonical: canonicalBytes,
			optimized: optimizedBytes,
			canonicalDigest: digest(canonicalBytes),
			optimizedDigest: digest(optimizedBytes),
		};
		mkdirSync(options.cacheDirectory, { recursive: true });
		const temporary = `${file}.tmp-${randomUUID()}`;
		try {
			writeFileSync(temporary, JSON.stringify(receipt), { flag: "wx" });
			renameSync(temporary, file);
		} finally {
			rmSync(temporary, { force: true });
		}
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
		if (error instanceof UnsupportedCoreModuleError)
			return { status: "unsupported", reason: error.message };
		throw error;
	}
}
