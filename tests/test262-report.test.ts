import { describe, expect, it } from "vitest";
import type { BatchManifest } from "../src/test262/artifact-cache.ts";
import { createTest262BatchReport, test262BatchId } from "../src/test262/report.ts";

describe("Test262 batch reporting", () => {
	it("derives a stable ID from ordered member paths", () => {
		const paths = ["test/language/a.js", "test/language/b.js"];

		expect(test262BatchId(paths)).toBe(
			"batch-f3a97a08f66298597086a018390d28cbfa9a6c5016ee247241418caa033d5213",
		);
		expect(test262BatchId([...paths].reverse())).not.toBe(test262BatchId(paths));
	});

	it("projects persisted manifest totals and execution metrics into the report", () => {
		const manifest = {
			schemaVersion: 1,
			hasBinary: true,
			generatedCBytes: 12_345,
			entries: [],
			resolved: [],
			stats: {
				compiledFiles: 2,
				functionCount: 30,
				instructionCount: 400,
				opcodes: { Move: 12 },
			},
			physical: {
				definitionCount: 1,
				sharedHelperCount: 3,
				functionCount: 20,
				instructionCount: 250,
				opcodes: { Move: 8 },
			},
		} satisfies BatchManifest;

		const report = createTest262BatchReport({
			paths: ["test/a.js", "test/b.js"],
			manifest,
			objectBytes: 9_876,
			cache: "hit",
			worker: 4,
			timings: {
				compileMs: null,
				ccMs: null,
				linkMs: 1.23456,
				runMs: 7.89012,
			},
		});

		expect(report).toMatchObject({
			paths: ["test/a.js", "test/b.js"],
			generatedCBytes: 12_345,
			logical: {
				compiledFiles: 2,
				functionCount: 30,
				instructionCount: 400,
			},
			physical: {
				definitionCount: 1,
				sharedHelperCount: 3,
				functionCount: 20,
				instructionCount: 250,
			},
			objectBytes: 9_876,
			cache: "hit",
			worker: 4,
			timings: {
				compileMs: null,
				ccMs: null,
				linkMs: 1.235,
				runMs: 7.89,
			},
		});
	});
});
