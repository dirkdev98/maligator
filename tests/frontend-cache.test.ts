import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cacheFrontendCompilerArtifact,
	cacheFrontendWire,
	frontendCompilerArtifactPath,
	frontendDigest,
	frontendWirePath,
	FrontendCompilationSession,
} from "../src/frontend-cache.ts";

describe("shared frontend artifact cache", () => {
	it("publishes wire images by content and repairs corrupt artifacts", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-frontend-cache-"));
		const wire = Uint8Array.from([1, 2, 3, 4]);
		const expected = frontendWirePath(frontendDigest(wire), root);

		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(new Uint8Array(readFileSync(expected))).toEqual(wire);

		writeFileSync(expected, Uint8Array.from([9]));
		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(new Uint8Array(readFileSync(expected))).toEqual(wire);
	});

	it("keeps compiler artifacts physically separate from runtime images", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-frontend-compiler-cache-"));
		const artifact = Uint8Array.from([4, 3, 2, 1]);
		const expected = frontendCompilerArtifactPath(frontendDigest(artifact), root);

		expect(cacheFrontendCompilerArtifact(artifact, root)).toBe(expected);
		expect(expected.endsWith(".malc")).toBe(true);
		expect(new Uint8Array(readFileSync(expected))).toEqual(artifact);
	});

	it("reuses persistent file digests and distrusts changed stat identities", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-frontend-digests-"));
		const cacheDirectory = path.join(root, "cache");
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const answer = 41;\n");

		const cold = new FrontendCompilationSession();
		cold.useCacheDirectory(cacheDirectory);
		const original = cold.snapshot(source);
		expect(cold.digestStatistics()).toEqual({ hits: 0, misses: 1 });
		cold.flush();

		const warm = new FrontendCompilationSession();
		warm.useCacheDirectory(cacheDirectory);
		expect(warm.snapshot(source)).toEqual(original);
		expect(warm.digestStatistics()).toEqual({ hits: 1, misses: 0 });

		const times = statSync(source);
		writeFileSync(source, "export const answer = 42;\n");
		utimesSync(source, times.atime, times.mtime);
		const changed = new FrontendCompilationSession();
		changed.useCacheDirectory(cacheDirectory);
		expect(changed.snapshot(source).digest).not.toBe(original.digest);
		expect(changed.digestStatistics()).toEqual({ hits: 0, misses: 1 });
	});
});
