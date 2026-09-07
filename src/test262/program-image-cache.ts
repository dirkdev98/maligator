import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { touchCacheEntry } from "../cache-management.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { compilerImplementationDigest } from "../compiler-cache-identity.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "../compiler/target/program-image.ts";
import { TEST262_METADATA } from "./constants.ts";
import type { Test262Frontmatter } from "./types.ts";

const CACHE_PROTOCOL = 2;

interface ProgramImageManifest {
	schemaVersion: 1;
	artifactDigest: string;
	artifactBytes: number;
}

export interface Test262ProgramImageCacheInput {
	path: string;
	source: string;
	frontmatter?: Test262Frontmatter;
	variant: "strict" | "sloppy";
	revision?: string;
	compilerDigest?: string;
	cacheDirectory?: string;
}

export type Test262ProgramImageCacheRead =
	| { state: "hit"; image: ProgramImage; bytes: number }
	| { state: "miss" }
	| { state: "corrupt"; reason: string };

/**
 * Backend-neutral identity: native C and MALW emission consume the same lowered
 * ProgramImage. The pinned corpus revision covers module/dynamic-import fixture
 * dependencies that are not present in the composed entry source itself.
 */
export function test262ProgramImageCacheKey(
	input: Omit<Test262ProgramImageCacheInput, "cacheDirectory">,
): string {
	return hash(
		"sha256",
		JSON.stringify({
			protocol: CACHE_PROTOCOL,
			compiler: input.compilerDigest ?? compilerImplementationDigest(),
			revision: input.revision ?? TEST262_METADATA.revision,
			semanticConfig: "test262-full-runtime-v1",
			variant: input.variant,
			path: input.path,
			frontmatter: input.frontmatter ?? {},
			source: input.source,
		}),
		"hex",
	);
}

function artifactDirectory(input: Test262ProgramImageCacheInput): string {
	const key = test262ProgramImageCacheKey(input);
	const compilerGeneration = hash(
		"sha256",
		input.compilerDigest ?? compilerImplementationDigest(),
		"hex",
	);
	const root = input.cacheDirectory ?? maligatorCacheDirectory();
	return path.join(
		root,
		"test262-program-images",
		compilerGeneration,
		key.slice(0, 2),
		key,
	);
}

function validManifest(value: unknown): value is ProgramImageManifest {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<ProgramImageManifest>;
	return (
		manifest.schemaVersion === 1 &&
		typeof manifest.artifactDigest === "string" &&
		/^[0-9a-f]{64}$/.test(manifest.artifactDigest) &&
		typeof manifest.artifactBytes === "number" &&
		Number.isSafeInteger(manifest.artifactBytes) &&
		manifest.artifactBytes > 0
	);
}

export function loadTest262ProgramImage(
	input: Test262ProgramImageCacheInput,
): Test262ProgramImageCacheRead {
	const directory = artifactDirectory(input);
	const manifestPath = path.join(directory, "manifest.json");
	if (!existsSync(manifestPath)) return { state: "miss" };
	try {
		const manifestValue: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (!validManifest(manifestValue)) throw new Error("invalid manifest");
		const artifact = readFileSync(path.join(directory, "program.malc"));
		if (
			artifact.length !== manifestValue.artifactBytes ||
			hash("sha256", artifact, "hex") !== manifestValue.artifactDigest
		) {
			throw new Error("artifact integrity mismatch");
		}
		const image = deserializeCompilerArtifact(artifact);
		touchCacheEntry(directory);
		return { state: "hit", image, bytes: artifact.length };
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		return {
			state: "corrupt",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Atomically publish an integrity-checked ProgramImage. Concurrent duplicates are benign. */
export function storeTest262ProgramImage(
	input: Test262ProgramImageCacheInput,
	image: ProgramImage,
): number {
	const directory = artifactDirectory(input);
	const parent = path.dirname(directory);
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, ".publish-"));
	const artifact = serializeCompilerArtifact(image);
	const manifest: ProgramImageManifest = {
		schemaVersion: 1,
		artifactDigest: hash("sha256", artifact, "hex"),
		artifactBytes: artifact.length,
	};
	try {
		writeFileSync(path.join(temporaryDirectory, "program.malc"), artifact);
		writeFileSync(
			path.join(temporaryDirectory, "manifest.json"),
			`${JSON.stringify(manifest)}\n`,
		);
		try {
			renameSync(temporaryDirectory, directory);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	return artifact.length;
}
