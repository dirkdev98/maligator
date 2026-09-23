import { hash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { touchCacheEntry } from "./cache-management.ts";
import { compilerProducerIdentity } from "./compiler-cache-identity.ts";
import { CoreAnalysisManager } from "./compiler/core/core-analysis-manager.ts";
import { CoreAnalysisScratchPool } from "./compiler/core/core-analysis-scratch.ts";
import { lowerSemanticProgramToCore } from "./compiler/core/core-frontend.ts";
import { CoreFunctionFeatureIndex } from "./compiler/core/core-function-features.ts";
import {
	CoreLocalOptimizer,
	CoreLocalRuleRegistry,
} from "./compiler/core/core-local-optimizer.ts";
import { CORE_CONSTRUCTION_NORMALIZATION_PASSES } from "./compiler/core/core-local-passes.ts";
import {
	captureCoreModule,
	decodeCoreModule,
	encodeCoreModule,
	UnsupportedCoreModuleError,
	CORE_MODULE_MAX_ENCODED_LENGTH,
	CORE_MODULE_RECIPE as RECIPE,
} from "./compiler/core/core-module-artifact.ts";
import type { CoreModuleArtifact } from "./compiler/core/core-module-artifact.ts";
import { CoreOptimizationReportBuilder } from "./compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "./compiler/core/core-pass-manager.ts";
import { CoreOptimizationBudgetError } from "./compiler/core/core-pass.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { ModuleRecord } from "./compiler/frontend/module-graph.ts";
import { parseModule } from "./compiler/frontend/parser.ts";
import { conservativeCompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";

const BOUNDARY = "strict-esm-private-cells-boxed-local-v4";
const RECEIPT_SCHEMA = 4;
type CapturePolicy = "full" | "optimized-only";
export interface CoreModuleCacheOptions {
	source: string;
	sourcePath: string;
	moduleKey: string;
	cacheDirectory: string;
	maxWorkItems?: number;
	maxEdits?: number;
	capturePolicy?: CapturePolicy;
	onWork?: (phase: "construct" | "optimize", functions: number) => void;
	/** The parsed tree must correspond to source under this stripping/transform producer. */
	parsed?: { result: ModuleRecord["parsed"]; producer: string };
}
export type CoreModuleCacheResult =
	| {
			status: "ready";
			cache: "hit" | "miss";
			/** Canonical access loads published bytes; optimized-only receipts need reconstruction. */
			canonical: CoreModuleArtifact;
			optimized: CoreModuleArtifact;
			completedRecipe: typeof RECIPE;
			key: string;
			work: { constructedFunctions: number; optimizedFunctions: number };
	  }
	| { status: "unsupported" | "budget-limited"; reason: string };
interface ModuleReceipt {
	schema: typeof RECEIPT_SCHEMA;
	key: string;
	status: "ready";
	canonicalDigest: string | null;
	optimizedDigest: string;
}
interface CanonicalDescriptor {
	schema: typeof RECEIPT_SCHEMA;
	key: string;
	digest: string;
}
interface UnsupportedReceipt {
	schema: typeof RECEIPT_SCHEMA;
	key: string;
	unsupported: string;
	status: "unsupported" | "budget-limited";
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

function writeAtomic(file: string, bytes: string): void {
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, bytes, { flag: "wx" });
		renameSync(temporary, file);
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* A failed publication may leave no writable directory. */
		}
	}
}

function publishReceipt(
	directory: string,
	receipt: ModuleReceipt | UnsupportedReceipt,
	payloads: ReadonlyArray<{ digest: string; bytes: string }> = [],
): void {
	try {
		mkdirSync(directory, { recursive: true });
		for (const payload of payloads)
			writeAtomic(path.join(directory, `${payload.digest}.json`), payload.bytes);
		// Readers can only observe a manifest after its immutable payloads are complete.
		writeAtomic(path.join(directory, "manifest.json"), JSON.stringify(receipt));
	} catch (error) {
		// Optional persistence must not turn a valid build into a cache-permission failure.
		if (!(error instanceof Error) || !("code" in error)) throw error;
	}
}

function loadPayload(directory: string, expectedDigest: string): CoreModuleArtifact {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest))
		throw new Error("Invalid Core payload digest");
	const bytes = readFileSync(path.join(directory, `${expectedDigest}.json`), "utf8");
	if (digest(bytes) !== expectedDigest) throw new Error("Core payload digest mismatch");
	return decodeCoreModule(bytes);
}

function cacheKey(options: CoreModuleCacheOptions, capturePolicy: CapturePolicy): string {
	return digest(
		JSON.stringify({
			schema: RECEIPT_SCHEMA,
			boundary: BOUNDARY,
			recipe: RECIPE,
			producer: compilerProducerIdentity("core-module", RECEIPT_SCHEMA),
			module: options.moduleKey,
			source: digest(JSON.stringify(options.source)),
			maxWorkItems: options.maxWorkItems ?? 100_000,
			maxEdits: options.maxEdits ?? 100_000,
			parser: options.parsed?.producer,
			capturePolicy,
		}),
	);
}

function loadCanonical(
	directory: string,
	key: string,
	canonicalDigest: string | null,
): CoreModuleArtifact {
	if (canonicalDigest !== null) return loadPayload(directory, canonicalDigest);
	const descriptor = JSON.parse(
		readFileSync(path.join(directory, "canonical.json"), "utf8"),
	) as CanonicalDescriptor;
	if (descriptor.schema !== RECEIPT_SCHEMA || descriptor.key !== key)
		throw new Error("Canonical Core descriptor identity mismatch");
	return loadPayload(directory, descriptor.digest);
}

function constructCoreModule(options: CoreModuleCacheOptions) {
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
		sourceOrigins: {
			moduleKeys: new Map([[options.sourcePath, options.moduleKey]]),
		},
	});
	const functions = [...core.program.functionIds()];
	options.onWork?.("construct", functions.length);
	const exports = (core.context.data.moduleExports ?? []).map(({ name, slot }) => ({
		name,
		slot,
	}));
	return { core, functions, exports };
}

/** The expected key pins reconstruction to the receipt selected before inputs can change. */
export function reconstructCanonicalCoreModule(
	options: Omit<CoreModuleCacheOptions, "capturePolicy">,
	expectedKey: string,
): CoreModuleArtifact {
	const key = cacheKey(options, "optimized-only");
	if (key !== expectedKey)
		throw new Error("Canonical Core reconstruction input mismatch");
	const directory = path.join(options.cacheDirectory, key);
	const receipt = JSON.parse(
		readFileSync(path.join(directory, "manifest.json"), "utf8"),
	) as ModuleReceipt;
	if (
		receipt.schema !== RECEIPT_SCHEMA ||
		receipt.key !== key ||
		receipt.status !== "ready" ||
		receipt.canonicalDigest !== null ||
		typeof receipt.optimizedDigest !== "string"
	)
		throw new Error("No matching optimized-only Core receipt");
	loadPayload(directory, receipt.optimizedDigest);
	const { core, functions, exports } = constructCoreModule(options);
	const canonical = captureCoreModule(
		core.program,
		exports,
		functions[0]!,
		core.context.data,
	);
	const bytes = encodeCoreModule(canonical);
	if (bytes.length > CORE_MODULE_MAX_ENCODED_LENGTH)
		throw new UnsupportedCoreModuleError("Reusable Core exceeds the artifact size limit");
	const descriptor: CanonicalDescriptor = {
		schema: RECEIPT_SCHEMA,
		key,
		digest: digest(bytes),
	};
	try {
		writeAtomic(path.join(directory, `${descriptor.digest}.json`), bytes);
		writeAtomic(path.join(directory, "canonical.json"), JSON.stringify(descriptor));
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error)) throw error;
	}
	return canonical;
}

/** Callers import the selected variant and invoke its initializer before reading live exports. */
export function loadOrCompileCoreModule(
	options: CoreModuleCacheOptions,
): CoreModuleCacheResult {
	const maxWorkItems = options.maxWorkItems ?? 100_000;
	const maxEdits = options.maxEdits ?? 100_000;
	const capturePolicy = options.capturePolicy ?? "full";
	const key = cacheKey(options, capturePolicy);
	const directory = path.join(options.cacheDirectory, key);
	try {
		const receipt = JSON.parse(
			readFileSync(path.join(directory, "manifest.json"), "utf8"),
		) as ModuleReceipt | UnsupportedReceipt;
		if (
			receipt.schema === RECEIPT_SCHEMA &&
			receipt.key === key &&
			"unsupported" in receipt &&
			(receipt.status === "unsupported" || receipt.status === "budget-limited") &&
			typeof receipt.unsupported === "string"
		) {
			touchCacheEntry(directory);
			return {
				status: receipt.status,
				reason: receipt.unsupported,
			};
		}
		if (
			!("unsupported" in receipt) &&
			receipt.schema === RECEIPT_SCHEMA &&
			receipt.key === key &&
			receipt.status === "ready" &&
			(receipt.canonicalDigest === null || typeof receipt.canonicalDigest === "string") &&
			(receipt.canonicalDigest === null) === (capturePolicy === "optimized-only") &&
			typeof receipt.optimizedDigest === "string"
		) {
			const optimized = loadPayload(directory, receipt.optimizedDigest);
			let canonical: CoreModuleArtifact | undefined;
			touchCacheEntry(directory);
			return {
				status: "ready",
				cache: "hit",
				get canonical() {
					return (canonical ??= loadCanonical(directory, key, receipt.canonicalDigest));
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
		const { core, functions, exports } = constructCoreModule(options);
		let canonical: CoreModuleArtifact | undefined =
			capturePolicy === "full"
				? captureCoreModule(core.program, exports, functions[0]!, core.context.data)
				: undefined;
		const localRules = new CoreLocalRuleRegistry(core.program);
		const featureIndex = new CoreFunctionFeatureIndex(core.program, localRules.dispatch);
		const scratch = new CoreAnalysisScratchPool();
		const report = new CoreOptimizationReportBuilder(core.program, "off");
		const passes = CORE_CONSTRUCTION_NORMALIZATION_PASSES.map((pass) => ({
			...pass,
			budget: { maxWorkItems, maxEdits, exhaustion: "error" as const },
		}));
		for (const fn of functions) {
			options.onWork?.("optimize", 1);
			new CoreLocalOptimizer(core.program, fn, {
				maxWorkItems,
				maxEdits,
				budgetExhaustion: "error",
				ruleRegistry: localRules,
			}).run();
			const analyses = new CoreAnalysisManager(
				core.program,
				core.context,
				report,
				scratch,
			);
			new CoreFunctionPassScheduler(core.program, core.context, analyses, report, fn, {
				localOptimization: true,
				localOptimizationCompleted: true,
				localRules,
				featureIndex,
				localOptimizationBudget: {
					maxWorkItems,
					maxEdits,
					budgetExhaustion: "error",
				},
			}).runComponent("canonicalize", passes);
		}
		const optimized = captureCoreModule(
			core.program,
			exports,
			functions[0]!,
			core.context.data,
			{ retainPreparedImport: true },
		);
		const canonicalBytes =
			canonical === undefined ? undefined : encodeCoreModule(canonical);
		const optimizedBytes = encodeCoreModule(optimized);
		if (
			(canonicalBytes !== undefined &&
				canonicalBytes.length > CORE_MODULE_MAX_ENCODED_LENGTH) ||
			optimizedBytes.length > CORE_MODULE_MAX_ENCODED_LENGTH
		)
			throw new UnsupportedCoreModuleError(
				"Reusable Core exceeds the artifact size limit",
			);
		const receipt: ModuleReceipt = {
			schema: RECEIPT_SCHEMA,
			key,
			status: "ready",
			canonicalDigest: canonicalBytes === undefined ? null : digest(canonicalBytes),
			optimizedDigest: digest(optimizedBytes),
		};
		publishReceipt(directory, receipt, [
			...(canonicalBytes === undefined || receipt.canonicalDigest === null
				? []
				: [{ digest: receipt.canonicalDigest, bytes: canonicalBytes }]),
			{ digest: receipt.optimizedDigest, bytes: optimizedBytes },
		]);
		return {
			status: "ready",
			cache: "miss",
			get canonical() {
				return (canonical ??= loadCanonical(directory, key, null));
			},
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
			error instanceof CoreOptimizationBudgetError
		) {
			const status =
				error instanceof CoreOptimizationBudgetError ? "budget-limited" : "unsupported";
			publishReceipt(directory, {
				schema: RECEIPT_SCHEMA,
				key,
				unsupported: error.message,
				status,
			});
			return { status, reason: error.message };
		}
		throw error;
	}
}
