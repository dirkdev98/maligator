import { hash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripCompactTypes } from "./frontend/compact-type-strip.ts";
import { ModuleParseCache } from "./frontend/module-graph.ts";
import type { ModuleGraph } from "./frontend/module-graph.ts";
import { compileEntrypoint } from "./pipeline/compile-program.ts";
import {
	captureRootInputs,
	captureRootPackageAbsences,
	rootPhysicalModulePaths,
	RootInputChangedError,
	serializeRootFailure,
	validateRootInputs,
	validateRootPackageAbsences,
} from "./root-compilation.ts";
import type { RootBatch, RootBatchResult, RootJobResult } from "./root-compilation.ts";
import type { CompilerDiagnostic } from "./shared/compiler-diagnostics.ts";
import { serializeCompilerArtifact } from "./target/compiler-artifact-codec.ts";
import { serializeRuntimeImage } from "./target/program-image-codec.ts";

export function compileRootBatch(batch: RootBatch): RootBatchResult {
	const cancellation = new Int32Array(batch.cancellation);
	const checkpoint = () => {
		if (Atomics.load(cancellation, 0) !== 0)
			throw new DOMException("root compilation cancelled", "AbortError");
	};
	const results: Array<RootJobResult> = [];
	const parseCache = new ModuleParseCache();
	for (const job of batch.jobs) {
		try {
			checkpoint();
			validateRootInputs(batch.ownerInputs);
			validateRootPackageAbsences(batch.packageAbsences);
			let dependencies: ReturnType<typeof captureRootInputs> | undefined;
			let packageAbsences: Array<string> | undefined;
			const diagnostics: Array<CompilerDiagnostic> = [];
			const image = compileEntrypoint(job.entry.path, {
				...batch.options,
				entrySource: undefined,
				entryGoal: undefined,
				entryStrict: true,
				stripTypes: stripCompactTypes,
				parseCache,
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
				runPhase(phase, run) {
					checkpoint();
					const result = run();
					if (phase === "graph") {
						const graph = result as unknown as ModuleGraph;
						for (const file of rootPhysicalModulePaths(graph))
							if (!batch.ownerModulePaths.includes(file))
								throw new RootInputChangedError(file);
						dependencies = captureRootInputs(graph);
						packageAbsences = captureRootPackageAbsences(graph);
						validateRootPackageAbsences(batch.packageAbsences);
					}
					checkpoint();
					return result;
				},
			});
			if (dependencies === undefined || packageAbsences === undefined)
				throw new Error("compiler did not expose the root graph");
			validateRootInputs(batch.ownerInputs);
			const compilerArtifact = serializeCompilerArtifact(image);
			writeFileSync(
				path.join(batch.artifactDirectory, `${job.index}.malc`),
				compilerArtifact,
			);
			const compilerDigest = hash("sha256", compilerArtifact, "hex");
			const compilerSize = compilerArtifact.byteLength;
			const wire = serializeRuntimeImage(image.runtime);
			writeFileSync(path.join(batch.artifactDirectory, `${job.index}.malw`), wire);
			validateRootInputs(dependencies);
			validateRootPackageAbsences(batch.packageAbsences);
			validateRootPackageAbsences(packageAbsences);
			checkpoint();
			results.push({
				index: job.index,
				compilerSize,
				wireSize: wire.byteLength,
				dependencies,
				packageAbsences,
				diagnostics,
				compilerDigest,
				wireDigest: hash("sha256", wire, "hex"),
			});
		} catch (error) {
			results.push({ index: job.index, failure: serializeRootFailure(error) });
		}
	}
	return { results };
}
