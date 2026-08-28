import { hash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	loadTest262ProgramImage,
	storeTest262ProgramImage,
	test262ProgramImageCacheKey,
} from "../src/test262/program-image-cache.ts";

function programImage(source = "globalThis.answer = 42;", strict = true) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			"cache-test.js",
			parseScript(source, { strict }),
		),
	);
}

function cacheInput(cacheDirectory: string) {
	return {
		path: "test/example.js",
		source: "assert.sameValue(answer, 42);",
		variant: "strict" as const,
		revision: "test-revision",
		compilerDigest: "compiler-digest",
		cacheDirectory,
	};
}

describe("Test262 ProgramImage cache", () => {
	it("round-trips one backend-neutral compiler artifact", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-t262-image-"));
		try {
			const input = cacheInput(root);
			const image = programImage();
			const bytes = storeTest262ProgramImage(input, image);
			expect(bytes).toBeGreaterThan(0);
			const cached = loadTest262ProgramImage(input);
			expect(cached.state).toBe("hit");
			if (cached.state === "hit") expect(cached.image).toEqual(image);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("round-trips sloppy with-environment resolution", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-t262-image-"));
		try {
			const input = cacheInput(root);
			const image = programImage(
				"with ({ answer: 42 }) globalThis.result = answer;",
				false,
			);
			storeTest262ProgramImage(input, image);
			const cached = loadTest262ProgramImage(input);
			expect(cached.state).toBe("hit");
			if (cached.state === "hit") expect(cached.image).toEqual(image);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keys semantic source, variant, corpus, and compiler identity", () => {
		const base = cacheInput("unused");
		const key = test262ProgramImageCacheKey(base);
		expect(test262ProgramImageCacheKey({ ...base, variant: "sloppy" })).not.toBe(key);
		expect(test262ProgramImageCacheKey({ ...base, source: `${base.source}\n` })).not.toBe(
			key,
		);
		expect(test262ProgramImageCacheKey({ ...base, revision: "next" })).not.toBe(key);
		expect(test262ProgramImageCacheKey({ ...base, compilerDigest: "next" })).not.toBe(
			key,
		);
	});

	it("rejects and removes a corrupted artifact so the caller recompiles", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-t262-image-"));
		try {
			const input = cacheInput(root);
			storeTest262ProgramImage(input, programImage());
			const key = test262ProgramImageCacheKey(input);
			const generation = hash("sha256", input.compilerDigest, "hex");
			const directory = path.join(
				root,
				"test262-program-images",
				generation,
				key.slice(0, 2),
				key,
			);
			writeFileSync(path.join(directory, "program.malc"), "corrupt");
			expect(loadTest262ProgramImage(input)).toEqual({
				state: "corrupt",
				reason: "artifact integrity mismatch",
			});
			expect(existsSync(directory)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
