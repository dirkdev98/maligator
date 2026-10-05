import { hash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "../build-config-error.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import { CoreOptimizationPlanVerificationError } from "./core/core-ir-region-validity.ts";
import { CoreIrVerificationError } from "./core/core-ir-verifier.ts";
import { CoreOptimizationBudgetError } from "./core/core-pass.ts";
import type { ModuleGraph } from "./frontend/module-graph.ts";
import { SyntaxDiagnostic } from "./frontend/syntax-diagnostic.ts";
import type { WorkerEntryDeclaration } from "./frontend/worker-entries.ts";
import type { CompileEntrypointOptions } from "./pipeline/compile-program-common.ts";
import type { CompiledWorkerImage } from "./pipeline/compile-worker-images.ts";
import type { CompilerDiagnostic } from "./shared/compiler-diagnostics.ts";
import { ExecutionVerificationError } from "./target/verify-execution.ts";

export { workerRootEntries } from "./pipeline/compile-worker-images.ts";

export class RootInputChangedError extends Error {
	readonly path: string;
	constructor(file: string) {
		super(`compiler root input changed before publication: ${file}`);
		this.name = "RootInputChangedError";
		this.path = file;
	}
}

function inputIdentity(file: string, source?: string): FrontendDependencyIdentity {
	const resolved = path.resolve(file);
	const before = statSync(resolved);
	const current = readFileSync(resolved, "utf8");
	const after = statSync(resolved);
	if (
		!before.isFile() ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs ||
		before.ino !== after.ino ||
		before.dev !== after.dev ||
		(source !== undefined && current !== source)
	)
		throw new RootInputChangedError(resolved);
	return {
		path: resolved,
		size: before.size,
		mtimeMs: before.mtimeMs,
		ctimeMs: before.ctimeMs,
		ino: before.ino,
		dev: before.dev,
		digest: hash("sha256", current, "hex"),
	};
}

export function validateRootInputs(
	inputs: ReadonlyArray<FrontendDependencyIdentity>,
): void {
	for (const expected of inputs) {
		const current = inputIdentity(expected.path);
		if (
			current.size !== expected.size ||
			current.mtimeMs !== expected.mtimeMs ||
			current.ctimeMs !== expected.ctimeMs ||
			current.ino !== expected.ino ||
			current.dev !== expected.dev ||
			current.digest !== expected.digest
		)
			throw new RootInputChangedError(expected.path);
	}
}

export function captureRootInputs(graph: ModuleGraph): Array<FrontendDependencyIdentity> {
	const inputs = new Map<string, FrontendDependencyIdentity>();
	for (const record of graph.modules.values()) {
		if (record.host || (record.virtual && record.sourcePath === undefined)) continue;
		const input = inputIdentity(record.sourcePath ?? record.path, record.source);
		inputs.set(input.path, input);
		let directory = path.dirname(input.path);
		for (;;) {
			const file = path.join(directory, "package.json");
			if (existsSync(file) && !inputs.has(file)) inputs.set(file, inputIdentity(file));
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	return [...inputs.values()].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
}

export function captureRootPackageAbsences(graph: ModuleGraph): Array<string> {
	const missing = new Set<string>();
	for (const record of graph.modules.values()) {
		if (record.host || (record.virtual && record.sourcePath === undefined)) continue;
		let directory = path.dirname(record.sourcePath ?? record.path);
		for (;;) {
			const file = path.join(directory, "package.json");
			if (!existsSync(file)) missing.add(file);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	return [...missing].sort();
}

export function validateRootPackageAbsences(files: ReadonlyArray<string>): void {
	for (const file of files) if (existsSync(file)) throw new RootInputChangedError(file);
}

export function rootPhysicalModulePaths(graph: ModuleGraph): Array<string> {
	return [
		...new Set(
			[...graph.modules.values()]
				.filter(
					(record) =>
						!record.host && !(record.virtual && record.sourcePath === undefined),
				)
				.map((record) => path.resolve(record.sourcePath ?? record.path)),
		),
	].sort();
}

export type RootCompileOptions = Omit<
	CompileEntrypointOptions,
	| "stripTypes"
	| "parseCache"
	| "transformSource"
	| "runPhase"
	| "onDiagnostic"
	| "onProgramFacts"
	| "afterCoreOptimization"
>;

export interface RootJob {
	readonly index: number;
	readonly entry: WorkerEntryDeclaration;
}
export interface RootBatch {
	readonly jobs: ReadonlyArray<RootJob>;
	readonly options: RootCompileOptions;
	readonly ownerInputs: ReadonlyArray<FrontendDependencyIdentity>;
	readonly packageAbsences: ReadonlyArray<string>;
	readonly ownerModulePaths: ReadonlyArray<string>;
	readonly cancellation: SharedArrayBuffer;
}

export type RootFailure =
	| { readonly kind: "value"; readonly value: unknown }
	| {
			readonly kind: "error";
			readonly type: string;
			readonly baseType: string;
			readonly name: string;
			readonly message: string;
			readonly stack?: string;
			readonly properties: Readonly<Record<string, unknown>>;
			cause?: RootFailure;
			errors?: Array<RootFailure>;
	  };

export function serializeRootFailure(
	value: unknown,
	seen = new Map<Error, RootFailure>(),
): RootFailure {
	if (!(value instanceof Error)) return { kind: "value", value };
	const previous = seen.get(value);
	if (previous !== undefined) return previous;
	const prototype = Object.getPrototypeOf(value) as {
		constructor?: { name?: string };
	} | null;
	const properties: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(value)) {
		if (!["name", "message", "stack", "cause", "errors"].includes(key))
			properties[key] = (value as unknown as Record<string, unknown>)[key];
	}
	const failure: Extract<RootFailure, { kind: "error" }> = {
		kind: "error",
		type: prototype?.constructor?.name ?? "Error",
		baseType:
			value instanceof SyntaxError
				? "SyntaxError"
				: value instanceof TypeError
					? "TypeError"
					: value instanceof RangeError
						? "RangeError"
						: value instanceof ReferenceError
							? "ReferenceError"
							: value instanceof EvalError
								? "EvalError"
								: value instanceof URIError
									? "URIError"
									: value instanceof AggregateError
										? "AggregateError"
										: "Error",
		name: value.name,
		message: value.message,
		stack: value.stack,
		properties,
	};
	seen.set(value, failure);
	if (Object.hasOwn(value, "cause"))
		failure.cause = serializeRootFailure(value.cause, seen);
	if (value instanceof AggregateError)
		failure.errors = (value.errors as Array<unknown>).map((error) =>
			serializeRootFailure(error, seen),
		);
	return failure;
}

const errorPrototypes: Readonly<Record<string, object>> = {
	Error: Error.prototype,
	TypeError: TypeError.prototype,
	SyntaxError: SyntaxError.prototype,
	RangeError: RangeError.prototype,
	ReferenceError: ReferenceError.prototype,
	EvalError: EvalError.prototype,
	URIError: URIError.prototype,
	AggregateError: AggregateError.prototype,
	SyntaxDiagnostic: SyntaxDiagnostic.prototype,
	CoreIrVerificationError: CoreIrVerificationError.prototype,
	ExecutionVerificationError: ExecutionVerificationError.prototype,
	CoreOptimizationPlanVerificationError: CoreOptimizationPlanVerificationError.prototype,
	CoreOptimizationBudgetError: CoreOptimizationBudgetError.prototype,
	RootInputChangedError: RootInputChangedError.prototype,
	BuildConfigError: BuildConfigError.prototype,
};

export function deserializeRootFailure(
	failure: RootFailure,
	seen = new Map<RootFailure, unknown>(),
): unknown {
	if (failure.kind === "value") return failure.value;
	if (seen.has(failure)) return seen.get(failure);
	const error = new Error(failure.message);
	seen.set(failure, error);
	Object.setPrototypeOf(
		error,
		Object.hasOwn(errorPrototypes, failure.type)
			? errorPrototypes[failure.type]!
			: (errorPrototypes[failure.baseType] ?? Error.prototype),
	);
	error.name = failure.name;
	if (failure.stack !== undefined) error.stack = failure.stack;
	for (const [key, value] of Object.entries(failure.properties))
		Object.defineProperty(error, key, {
			value,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	if (failure.cause !== undefined)
		Object.defineProperty(error, "cause", {
			value: deserializeRootFailure(failure.cause, seen),
			writable: true,
			configurable: true,
		});
	if (failure.errors !== undefined)
		Object.defineProperty(error, "errors", {
			value: failure.errors.map((item) => deserializeRootFailure(item, seen)),
			writable: true,
			configurable: true,
		});
	return error;
}

export type RootJobResult =
	| { readonly index: number; readonly failure: RootFailure }
	| {
			readonly index: number;
			readonly compilerArtifact: Uint8Array;
			readonly compilerDigest: string;
			readonly wire: Uint8Array;
			readonly wireDigest: string;
			readonly dependencies: Array<FrontendDependencyIdentity>;
			readonly packageAbsences: Array<string>;
			readonly diagnostics: Array<CompilerDiagnostic>;
	  };
export interface RootBatchResult {
	readonly results: Array<RootJobResult>;
}

export interface RootCompilationResult {
	workers: Array<CompiledWorkerImage>;
	diagnostics: Array<CompilerDiagnostic>;
	dependencies: Array<FrontendDependencyIdentity>;
	packageAbsences: Array<string>;
}

export interface RootCompilation {
	result: Promise<RootCompilationResult>;
	cancel(reason?: unknown): void;
	close(): Promise<void>;
}

export interface RootCompilationControls {
	concurrency: number;
	signal?: AbortSignal;
}

export type StartRootCompilation = (
	graph: ModuleGraph,
	options: CompileEntrypointOptions,
	ownerInputs: ReadonlyArray<FrontendDependencyIdentity>,
	controls: RootCompilationControls,
) => RootCompilation;
