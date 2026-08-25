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
		schema: 2;
		javascript?: { modes: { closed: { wallMs: number; obsolete?: boolean } } };
		http?: { bare: { malRps: number } };
		selfCompile?: { maligatorMs: number };
	}
	const previous: Snapshot = {
		schema: 2,
		javascript: { modes: { closed: { wallMs: 20, obsolete: true } } },
		http: { bare: { malRps: 30 } },
		selfCompile: { maligatorMs: 40 },
	};
	const merged = mergeBenchmarkBaseline<Snapshot>(previous, {
		schema: 2,
		javascript: { modes: { closed: { wallMs: 15 } } },
	});

	expect(merged).toEqual({
		schema: 2,
		javascript: { modes: { closed: { wallMs: 15 } } },
		http: previous.http,
		selfCompile: previous.selfCompile,
	});
});

test("benchmark baseline is never written without an explicit update", () => {
	const file = temporaryFile();
	writeFileSync(file, '{"schema":2,"javascript":{"wallMs":20}}\n');
	const previous = readBenchmarkBaseline<{ schema: 2; javascript: { wallMs: number } }>(
		file,
	);

	persistBenchmarkBaseline(
		file,
		previous,
		{ schema: 2, javascript: { wallMs: 15 } },
		false,
	);
	expect(readFileSync(file, "utf8")).toBe('{"schema":2,"javascript":{"wallMs":20}}\n');

	const absent = temporaryFile();
	persistBenchmarkBaseline(
		absent,
		undefined,
		{ schema: 2, javascript: { wallMs: 15 } },
		false,
	);
	expect(existsSync(absent)).toBe(false);
});

test("benchmark baseline writes one unattributed snapshot on update", () => {
	const file = temporaryFile();
	interface Snapshot {
		schema: 2;
		http?: { bare: { malRps: number } };
		javascript?: { wallMs: number };
	}
	const previous: Snapshot = { schema: 2, http: { bare: { malRps: 10 } } };
	persistBenchmarkBaseline<Snapshot>(
		file,
		previous,
		{ schema: 2, javascript: { wallMs: 15 } },
		true,
	);

	expect(readBenchmarkBaseline(file)).toEqual({
		schema: 2,
		http: previous.http,
		javascript: { wallMs: 15 },
	});
	expect(readFileSync(file, "utf8")).not.toMatch(/"(?:entries|commit|dirty)"/);
});

test("committed benchmark baseline uses the explicit three-family schema", () => {
	const baseline = readBenchmarkBaseline<Record<string, unknown>>("bench/baseline.json");
	expect(baseline).toBeDefined();
	expect(Object.keys(baseline!).sort()).toEqual([
		"http",
		"javascript",
		"schema",
		"selfCompile",
	]);
	expect(baseline).toHaveProperty("schema", 3);
	expect(baseline).not.toHaveProperty("entries");
	expect(baseline).not.toHaveProperty("commit");
	expect(baseline).not.toHaveProperty("dirty");
	for (const retired of [
		"size",
		"compiler",
		"language",
		"module",
		"string",
		"promise",
		"coroutine",
		"arguments",
		"stackObject",
		"interpreter",
		"sqliteBinding",
		"prototypeCache",
		"gc",
	]) {
		expect(baseline).not.toHaveProperty(retired);
	}

	const javascript = baseline!.javascript as {
		runs: number;
		nativeBuild: {
			mode: string;
			optimizationFlags: Array<string>;
			lto: boolean;
		};
		modes: Record<
			string,
			{
				world: string;
				backend: string;
				config: { primordials: string; eval: boolean; realms: boolean };
			}
		>;
	};
	expect(javascript.runs).toBeGreaterThanOrEqual(5);
	expect(javascript.nativeBuild.mode).toBe("production");
	expect(javascript.nativeBuild.optimizationFlags).toContain("-O2");
	expect(javascript.nativeBuild.optimizationFlags).toContain("-g0");
	expect(Object.keys(javascript.modes).sort()).toEqual([
		"closed-compiled",
		"closed-interpreted",
		"open-compiled",
		"open-interpreted",
	]);
	for (const [name, mode] of Object.entries(javascript.modes)) {
		const [world, backend] = name.split("-");
		expect(mode).toMatchObject({ world, backend });
		expect(mode.config).toEqual(
			world === "closed"
				? { primordials: "locked", eval: false, realms: false }
				: { primordials: "mutable", eval: true, realms: true },
		);
	}

	expect(baseline!.http).toMatchObject({ world: "closed" });
	expect((baseline!.http as { runs: number }).runs).toBeGreaterThanOrEqual(5);
	expect(baseline!.selfCompile).toMatchObject({ world: "closed" });
	expect((baseline!.selfCompile as { runs: number }).runs).toBeGreaterThanOrEqual(5);
});
