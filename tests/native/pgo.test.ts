import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	preparePgoTraining,
	createPgoCapture,
	finalizePgoCapture,
	parsePgoCounts,
	mergePgoCaptures,
} from "../../src/pgo-artifact.ts";
import { buildNativeBinaryResult } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-pgo-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("VM PGO training", () => {
	it("counts original dispatch attempts and fresh entries across throws and resumptions", () => {
		const built = buildNativeBinaryResult({
			fixture: "tests/local/pgo.mjs",
			name: "pgo",
			outDir: directory,
			compiled: false,
			pgoTraining: true,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		});
		const prepared = preparePgoTraining(
			built.binaryPath,
			built.programImage,
			"a".repeat(64),
		);
		const capture = createPgoCapture(prepared, "event-semantics", directory);
		const result = spawnSync(built.binaryPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...capture.environment, MAL_INTERP: "1" },
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("12");
		finalizePgoCapture(capture, true);
		const counts = parsePgoCounts(
			readFileSync(path.join(capture.directory, "counts.bin")),
		);
		const entries = (name: string) =>
			prepared.functions.reduce(
				(sum, fn, i) => sum + (fn.name === name ? counts.functions[i]! : 0n),
				0n,
			);
		expect(entries("add")).toBe(7n);
		expect(entries("argumentFailure")).toBe(2n);
		expect(entries("defaults")).toBe(1n);
		expect(entries("recursive")).toBe(5n);
		expect(entries("generator")).toBe(2n);
		expect(entries("asynchronous")).toBe(1n);
		expect(entries("callback")).toBe(3n);
		expect(entries("spreadTarget")).toBe(1n);
		expect(entries("Box")).toBe(1n);
		expect(entries("tag")).toBe(1n);
		expect(prepared.calls.filter((site) => site.kind === "super")).toHaveLength(1);
		prepared.calls.forEach((site, index) => {
			if (
				site.kind === "super" ||
				site.kind === "tagged-template" ||
				site.kind === "construct"
			)
				expect(counts.calls[index]).toBe(1n);
		});
		const sourceLines = readFileSync("tests/local/pgo.mjs", "utf8").split("\n");
		const lineCounts = (text: string) =>
			prepared.calls.flatMap((site, i) =>
				site.line === sourceLines.findIndex((line) => line.includes(text)) + 1 &&
				site.instrumented
					? [counts.calls[i]!]
					: [],
			);
		expect(lineCounts("for (let i")).toEqual([3n]);
		expect(lineCounts("add(argumentFailure())")).toEqual([0n, 1n]);
		expect(lineCounts("defaults();")).toEqual([1n]);
		expect(lineCounts("null(1)")).toEqual([1n]);
		expect(lineCounts("absent?.")).toEqual([0n, 0n]);
		expect(lineCounts("add(...iterator)")).toEqual([0n]);
		const merged = mergePgoCaptures(
			[capture.directory, capture.directory],
			path.join(directory, "merged.json"),
		);
		expect(merged.profile.runs).toHaveLength(1);
		expect(merged.profile.coverage.observedZeroCalls).toBeGreaterThan(0);
	}, 120_000);
});
