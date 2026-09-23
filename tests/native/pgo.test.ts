import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	preparePgoTraining,
	createPgoCapture,
	finalizePgoCapture,
	parsePgoCounts,
	mergePgoCaptures,
} from "../../src/pgo-artifact.ts";
import {
	buildNativeBinaryResult,
	buildNativeProgramImageResult,
} from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-pgo-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("VM PGO training", () => {
	it("counts original dispatch attempts and fresh entries across throws and resumptions", () => {
		const options = {
			outDir: directory,
			pgoTraining: true as const,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		};
		const built = buildNativeBinaryResult({
			...options,
			fixture: "tests/local/pgo.mjs",
			name: "pgo-interpreted",
			compiled: false,
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
		const compiledSource = emitProgramImage(built.programImage, { compiled: true });
		expect(compiledSource).toContain("mal_pgo_entry(vm,");
		expect(compiledSource).toContain("mal_pgo_call(vm,");
		const compiled = buildNativeProgramImageResult(built.programImage, {
			...options,
			name: "pgo-compiled",
			compiled: true,
		});
		const compiledPrepared = preparePgoTraining(
			compiled.binaryPath,
			compiled.programImage,
			"a".repeat(64),
		);
		expect(compiledPrepared.functions).toEqual(prepared.functions);
		expect(compiledPrepared.calls).toEqual(prepared.calls);
		const compiledCapture = createPgoCapture(
			compiledPrepared,
			"event-semantics-compiled",
			directory,
		);
		const compiledResult = spawnSync(compiled.binaryPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...compiledCapture.environment, MAL_INTERP: "0" },
		});
		expect(compiledResult.stderr).toBe("");
		expect(compiledResult.status).toBe(0);
		expect(compiledResult.stdout).toBe(result.stdout);
		finalizePgoCapture(compiledCapture, true);
		const compiledCounts = parsePgoCounts(
			readFileSync(path.join(compiledCapture.directory, "counts.bin")),
		);
		expect(compiledCounts.functions).toEqual(counts.functions);
		expect(compiledCounts.calls).toEqual(counts.calls);
		expect(compiledCounts.targets).toEqual(counts.targets);
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
		const loopSite = prepared.calls.findIndex(
			(site) =>
				site.line === sourceLines.findIndex((line) => line.includes("for (let i")) + 1 &&
				site.instrumented,
		);
		const addIndex = prepared.functions.findIndex((fn) => fn.name === "add");
		expect(prepared.calls[loopSite]?.targetInstrumented).toBe(true);
		expect(counts.targets[loopSite]).toEqual({
			truncated: false,
			entries: [{ functionIndex: addIndex, count: 3n }],
		});
		expect(lineCounts("add(argumentFailure())")).toEqual([0n, 1n]);
		expect(lineCounts("defaults();")).toEqual([1n]);
		expect(lineCounts("null(1)")).toEqual([1n]);
		expect(lineCounts("absent?.")).toEqual([0n, 0n]);
		expect(lineCounts("add(...iterator)")).toEqual([0n]);
		expect(
			prepared.calls.find(
				(site) =>
					site.line ===
					sourceLines.findIndex((line) => line.includes("add(...iterator)")) + 1,
			)?.targetInstrumented,
		).toBe(false);
		const merged = mergePgoCaptures(
			[capture.directory, capture.directory],
			path.join(directory, "merged.json"),
		);
		expect(merged.profile.runs).toHaveLength(1);
		expect(merged.profile.coverage.observedZeroCalls).toBeGreaterThan(0);
	}, 120_000);
	it("attributes raw guarded callees across misses, throws and target-table truncation", () => {
		const options = {
			outDir: directory,
			pgoTraining: true as const,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		};
		const built = buildNativeBinaryResult({
			...options,
			fixture: "tests/local/pgo-targets.mjs",
			name: "pgo-targets-interpreted",
			compiled: false,
		});
		const interpreted = preparePgoTraining(
			built.binaryPath,
			built.programImage,
			"a".repeat(64),
		);
		const first = createPgoCapture(interpreted, "targets-interpreted", directory);
		const result = spawnSync(built.binaryPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...first.environment, MAL_INTERP: "1" },
		});
		expect(result).toMatchObject({ status: 0, stdout: "26\n", stderr: "" });
		finalizePgoCapture(first, true);
		const counts = parsePgoCounts(readFileSync(path.join(first.directory, "counts.bin")));
		const compiled = buildNativeProgramImageResult(built.programImage, {
			...options,
			name: "pgo-targets-compiled",
			compiled: true,
		});
		const compiledPrepared = preparePgoTraining(
			compiled.binaryPath,
			compiled.programImage,
			"a".repeat(64),
		);
		expect(compiledPrepared.functions).toEqual(interpreted.functions);
		expect(compiledPrepared.calls).toEqual(interpreted.calls);
		const second = createPgoCapture(compiledPrepared, "targets-compiled", directory);
		const compiledResult = spawnSync(compiled.binaryPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...second.environment, MAL_INTERP: "0" },
		});
		expect(compiledResult).toMatchObject({ status: 0, stdout: "26\n", stderr: "" });
		finalizePgoCapture(second, true);
		const compiledCounts = parsePgoCounts(
			readFileSync(path.join(second.directory, "counts.bin")),
		);
		expect(compiledCounts.functions).toEqual(counts.functions);
		expect(compiledCounts.calls).toEqual(counts.calls);
		expect(compiledCounts.targets).toEqual(counts.targets);
		const source = readFileSync("tests/local/pgo-targets.mjs", "utf8").split("\n");
		const site = (text: string) => {
			const line = source.findIndex((row) => row.includes(text)) + 1;
			return interpreted.calls.findIndex(
				(entry) => entry.line === line && entry.instrumented,
			);
		};
		const name = (index: number) => interpreted.functions[index]?.name;
		const invoke = site("return fn(1)");
		expect(interpreted.calls[invoke]?.targetInstrumented).toBe(true);
		expect(counts.calls[invoke]).toBe(10n);
		expect(counts.targets[invoke]?.truncated).toBe(true);
		expect(
			counts.targets[invoke]?.entries.map((entry) => [
				name(entry.functionIndex),
				entry.count,
			]),
		).toEqual([
			["a", 2n],
			["b", 2n],
			["throwsAfterGuard", 1n],
			["c", 1n],
		]);
		const changed = site("assigned(change())");
		expect(
			counts.targets[changed]?.entries.map((entry) => name(entry.functionIndex)),
		).toEqual(["a"]);
		const failed = site("assigned(fails())");
		expect(counts.calls[failed]).toBe(0n);
		expect(counts.targets[failed]?.entries).toEqual([]);
	});
});
