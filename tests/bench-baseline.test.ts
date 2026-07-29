import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	mergeBenchmarkBaseline,
	persistBenchmarkBaseline,
	readBenchmarkBaseline,
} from "../scripts/bench-baseline.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryFile(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-bench-baseline-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "baseline.json");
}

test("benchmark baseline partial updates replace selected sections atomically", () => {
	interface Snapshot {
		size?: { full: { binaryBytes: number } };
		language?: { malMs: number; obsolete?: boolean };
		http?: { malRps: number };
	}
	const previous: Snapshot = {
		size: { full: { binaryBytes: 10 } },
		language: { malMs: 20, obsolete: true },
		http: { malRps: 30 },
	};
	const merged = mergeBenchmarkBaseline<Snapshot>(previous, { language: { malMs: 15 } });

	expect(merged).toEqual({
		size: previous.size,
		language: { malMs: 15 },
		http: previous.http,
	});
});

test("benchmark baseline is never written without an explicit update", () => {
	const file = temporaryFile();
	writeFileSync(file, '{"language":{"malMs":20}}\n');
	const previous = readBenchmarkBaseline<{ language: { malMs: number } }>(file);

	persistBenchmarkBaseline(file, previous, { language: { malMs: 15 } }, false);
	expect(readFileSync(file, "utf8")).toBe('{"language":{"malMs":20}}\n');

	const absent = temporaryFile();
	persistBenchmarkBaseline(absent, undefined, { language: { malMs: 15 } }, false);
	expect(existsSync(absent)).toBe(false);
});

test("benchmark baseline writes one unattributed snapshot on update", () => {
	const file = temporaryFile();
	interface Snapshot {
		size?: { full: { binaryBytes: number } };
		language?: { malMs: number };
	}
	const previous: Snapshot = { size: { full: { binaryBytes: 10 } } };
	persistBenchmarkBaseline<Snapshot>(file, previous, { language: { malMs: 15 } }, true);

	expect(readBenchmarkBaseline(file)).toEqual({
		size: previous.size,
		language: { malMs: 15 },
	});
	expect(readFileSync(file, "utf8")).not.toMatch(/"(?:entries|commit|dirty)"/);
});

test("committed benchmark baseline is one unattributed snapshot", () => {
	const baseline = readBenchmarkBaseline<Record<string, unknown>>("bench/baseline.json");
	expect(baseline).toBeDefined();
	expect(baseline).not.toHaveProperty("entries");
	expect(baseline).not.toHaveProperty("commit");
	expect(baseline).not.toHaveProperty("dirty");
});
