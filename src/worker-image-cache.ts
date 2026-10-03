import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "./cache-root.ts";
import type { WorkerEntryDeclaration } from "./compiler/frontend/worker-entries.ts";
import { developmentWorkerManifest } from "./compiler/pipeline/compile-worker-images.ts";
import type { CompiledWorkerImage } from "./compiler/pipeline/compile-worker-images.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "./compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import {
	cacheFrontendCompilerArtifact,
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendArtifactIdentity,
	frontendArtifactUnchanged,
	frontendCompilerArtifactIdentity,
	frontendCompilerArtifactUnchanged,
	frontendCompilerArtifactPath,
	frontendDigest,
	frontendWirePath,
} from "./frontend-cache.ts";
import type { FrontendArtifactIdentity } from "./frontend-cache.ts";

export interface WorkerImageArtifact {
	readonly id: string;
	readonly entry: WorkerEntryDeclaration;
	readonly runtime: FrontendArtifactIdentity;
	readonly compiler: FrontendArtifactIdentity;
}

export function cacheWorkerImages(
	workers: ReadonlyArray<CompiledWorkerImage>,
	artifactRoot: string,
): Array<WorkerImageArtifact> {
	return workers.map((worker) => {
		cacheFrontendWire(worker.wire, artifactRoot);
		const runtime = frontendArtifactIdentity(frontendDigest(worker.wire), artifactRoot);
		const compilerWire = serializeCompilerArtifact(worker.image);
		cacheFrontendCompilerArtifact(compilerWire, artifactRoot);
		const compiler = frontendCompilerArtifactIdentity(
			frontendDigest(compilerWire),
			artifactRoot,
		);
		if (runtime === undefined || compiler === undefined)
			throw new Error("worker image artifacts missing after publication");
		return { id: worker.id, entry: worker.entry, runtime, compiler };
	});
}

export function workerImageArtifactsUnchanged(
	value: unknown,
	artifactRoot: string,
): value is Array<WorkerImageArtifact> {
	if (!Array.isArray(value)) return false;
	return value.every((candidate: unknown) => {
		if (typeof candidate !== "object" || candidate === null) return false;
		const item = candidate as Partial<WorkerImageArtifact>;
		return (
			typeof item.id === "string" &&
			/^[0-9a-f]{20}$/.test(item.id) &&
			typeof item.entry?.href === "string" &&
			item.entry.href.startsWith("file:") &&
			typeof item.entry.path === "string" &&
			typeof item.entry.importer === "string" &&
			item.runtime !== undefined &&
			item.compiler !== undefined &&
			typeof item.runtime.digest === "string" &&
			/^[0-9a-f]{64}$/.test(item.runtime.digest) &&
			typeof item.compiler.digest === "string" &&
			/^[0-9a-f]{64}$/.test(item.compiler.digest) &&
			frontendArtifactUnchanged(item.runtime, artifactRoot) &&
			frontendCompilerArtifactUnchanged(item.compiler, artifactRoot)
		);
	});
}

export function restoreWorkerImages(
	records: ReadonlyArray<WorkerImageArtifact>,
	artifactRoot: string,
): Array<CompiledWorkerImage> {
	return records.map((record) => {
		let wire: Uint8Array | undefined;
		let image: ProgramImage | undefined;
		return {
			id: record.id,
			entry: record.entry,
			get wire() {
				if (wire !== undefined) return wire;
				const bytes = new Uint8Array(
					readFileSync(frontendWirePath(record.runtime.digest, artifactRoot)),
				);
				if (frontendDigest(bytes) !== record.runtime.digest)
					throw new Error("worker runtime image digest mismatch");
				return (wire = bytes);
			},
			get image() {
				if (image !== undefined) return image;
				const bytes = new Uint8Array(
					readFileSync(
						frontendCompilerArtifactPath(record.compiler.digest, artifactRoot),
					),
				);
				if (frontendDigest(bytes) !== record.compiler.digest)
					throw new Error("worker compiler image digest mismatch");
				return (image = deserializeCompilerArtifact(bytes));
			},
		};
	});
}

export function cacheDevelopmentWorkerManifest(
	workers: ReadonlyArray<CompiledWorkerImage>,
	cacheDirectory?: string,
	includeEmpty = false,
): string | undefined {
	if (workers.length === 0 && !includeEmpty) return undefined;
	const artifactRoot = frontendArtifactCacheRoot(cacheDirectory);
	const manifest = developmentWorkerManifest(workers, (wire) =>
		cacheFrontendWire(wire, artifactRoot),
	);
	const source = `${JSON.stringify(manifest)}\n`;
	const directory = path.join(
		maligatorCacheDirectory(cacheDirectory),
		"worker-manifests",
	);
	mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${frontendDigest(source)}.json`);
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, source);
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
	return file;
}

export function workerManifestArguments(manifest: string | undefined): Array<string> {
	return manifest === undefined ? [] : ["--maligator-internal-workers", manifest];
}

export function writeSerializedWorkerManifest(
	workers: ReadonlyArray<CompiledWorkerImage>,
	output: string,
): string | undefined {
	if (workers.length === 0) return undefined;
	const manifest = `${path.resolve(output)}.workers.json`;
	const directory = `${path.resolve(output)}.workers`;
	mkdirSync(directory, { recursive: true });
	const payload = developmentWorkerManifest(workers, (wire, digest) => {
		const file = path.join(directory, `${digest}.malw`);
		writeFileSync(file, wire);
		return path.relative(path.dirname(manifest), file);
	});
	writeFileSync(manifest, `${JSON.stringify(payload)}\n`);
	return manifest;
}
