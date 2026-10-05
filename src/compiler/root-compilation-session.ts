import { hash } from "node:crypto";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import { stripCompactTypes } from "./frontend/compact-type-strip.ts";
import type { ModuleGraph } from "./frontend/module-graph.ts";
import type { CompileEntrypointOptions } from "./pipeline/compile-program-common.ts";
import type { CompiledWorkerImage } from "./pipeline/compile-worker-images.ts";
import {
	captureRootPackageAbsences,
	deserializeRootFailure,
	rootPhysicalModulePaths,
	serializeRootFailure,
	validateRootInputs,
	validateRootPackageAbsences,
	workerRootEntries,
} from "./root-compilation.ts";
import type {
	RootBatch,
	RootBatchResult,
	RootCompilation,
	RootCompilationControls,
	RootCompilationResult,
	RootJob,
	RootJobResult,
} from "./root-compilation.ts";
import type { CompilerDiagnostic } from "./shared/compiler-diagnostics.ts";
import { deserializeCompilerArtifact } from "./target/compiler-artifact-codec.ts";

// Admission starts synchronously; settlement must follow the host's final thread join.
export type RootBatchLauncher = (batch: RootBatch) => Promise<Array<RootJobResult>>;

export function failedRootBatch(batch: RootBatch, error: unknown): Array<RootJobResult> {
	return batch.jobs.map((job) => ({
		index: job.index,
		failure: serializeRootFailure(error),
	}));
}

export function rootBatchReceiver(batch: RootBatch) {
	let report: RootBatchResult | undefined;
	let failed = false;
	let failure: unknown;
	return {
		message(value: unknown) {
			if (report !== undefined) {
				failed = true;
				failure = new Error("root worker sent duplicate completion");
			} else if (
				typeof value !== "object" ||
				value === null ||
				!("results" in value) ||
				!Array.isArray(value.results)
			) {
				failed = true;
				failure = new Error("root worker sent invalid completion");
			} else report = value as RootBatchResult;
		},
		fail(error: unknown) {
			failed = true;
			failure = error;
		},
		joined(code: number): Array<RootJobResult> {
			if (!failed && (code !== 0 || report === undefined)) {
				failed = true;
				failure = new Error(
					`root worker exited before successful completion (code ${code})`,
				);
			}
			return failed ? failedRootBatch(batch, failure) : report!.results;
		},
	};
}

export function startRootCompilation(
	graph: ModuleGraph,
	options: CompileEntrypointOptions,
	ownerInputs: ReadonlyArray<FrontendDependencyIdentity>,
	controls: RootCompilationControls,
	launch: RootBatchLauncher,
): RootCompilation {
	if (
		!Number.isSafeInteger(controls.concurrency) ||
		controls.concurrency < 1 ||
		controls.concurrency > 2
	)
		throw new RangeError("root helper count must be 1 or 2");
	if (
		options.stripTypes !== stripCompactTypes ||
		options.transformSource !== undefined ||
		options.afterCoreOptimization !== undefined ||
		options.onProgramFacts !== undefined
	)
		throw new TypeError(
			"roots require compact stripping and serializable compiler options",
		);
	validateRootInputs(ownerInputs);
	const ownerPackageAbsences = captureRootPackageAbsences(graph);
	const {
		stripTypes: _strip,
		parseCache: _parse,
		runPhase: _phase,
		onDiagnostic: _diagnostic,
		transformSource: _transform,
		afterCoreOptimization: _after,
		onProgramFacts: _facts,
		...serializable
	} = options;
	const compileOptions = structuredClone({
		...serializable,
		dynamicImportCandidates: graph.dynamicImportCandidates ?? [],
	});
	const entries = workerRootEntries(graph);
	const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const state = new Int32Array(cancellation);
	let cancelled = false;
	let cancellationReason: unknown;
	const cancel = (...reasons: [] | [unknown]) => {
		if (cancelled) return;
		cancelled = true;
		cancellationReason =
			reasons.length === 0
				? new DOMException("root compilation cancelled", "AbortError")
				: reasons[0];
		Atomics.store(state, 0, 1);
	};
	const onAbort = () => {
		const reason: unknown = controls.signal?.reason;
		cancel(reason);
	};
	controls.signal?.addEventListener("abort", onAbort, { once: true });
	if (controls.signal?.aborted) onAbort();
	const joined: Array<Promise<Array<RootJobResult>>> = [];
	const count = cancelled ? 0 : Math.min(controls.concurrency, entries.length);
	for (let partition = 0; partition < count; partition++) {
		const jobs: Array<RootJob> = entries.flatMap((entry, index) =>
			index % count === partition ? [{ entry, index }] : [],
		);
		const batch: RootBatch = {
			jobs,
			options: compileOptions,
			ownerInputs,
			packageAbsences: ownerPackageAbsences,
			ownerModulePaths: rootPhysicalModulePaths(graph),
			cancellation,
		};
		try {
			joined.push(launch(batch).catch((error) => failedRootBatch(batch, error)));
		} catch (error) {
			joined.push(Promise.resolve(failedRootBatch(batch, error)));
		}
	}
	const drained = Promise.all(joined).finally(() =>
		controls.signal?.removeEventListener("abort", onAbort),
	);
	const result = drained.then((partitions): RootCompilationResult => {
		if (cancelled) throw cancellationReason;
		const records = partitions.flat().sort((left, right) => left.index - right.index);
		if (
			records.length !== entries.length ||
			records.some((record, index) => record.index !== index)
		)
			throw new Error("root worker completion did not cover every declaration");
		const diagnostics: Array<CompilerDiagnostic> = [];
		const dependencies = new Map(ownerInputs.map((input) => [input.path, input]));
		const packageAbsences = new Set(ownerPackageAbsences);
		const workers = records.map((record): CompiledWorkerImage => {
			if ("failure" in record) throw deserializeRootFailure(record.failure);
			if (
				hash("sha256", record.compilerArtifact, "hex") !== record.compilerDigest ||
				hash("sha256", record.wire, "hex") !== record.wireDigest
			)
				throw new Error(
					`root worker artifact digest mismatch: ${entries[record.index]!.href}`,
				);
			validateRootInputs(record.dependencies);
			validateRootPackageAbsences(record.packageAbsences);
			for (const file of record.packageAbsences) packageAbsences.add(file);
			for (const input of record.dependencies) {
				const previous = dependencies.get(input.path);
				if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(input))
					throw new Error(`root input generations differ: ${input.path}`);
				dependencies.set(input.path, input);
			}
			diagnostics.push(...record.diagnostics);
			const entry = entries[record.index]!;
			return {
				id: hash("sha256", entry.href, "hex").slice(0, 20),
				entry,
				image: deserializeCompilerArtifact(record.compilerArtifact),
				wire: record.wire,
			};
		});
		const inputs = [...dependencies.values()].sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
		validateRootInputs(inputs);
		const missing = [...packageAbsences].sort();
		validateRootPackageAbsences(missing);
		return { workers, diagnostics, dependencies: inputs, packageAbsences: missing };
	});
	void result.catch(() => {});
	return {
		result,
		cancel,
		close: async () => {
			await drained;
		},
	};
}
