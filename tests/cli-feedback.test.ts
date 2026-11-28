import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

const cliEntry = resolve("src/index.ts");
const coldRunnerTimeoutMs = 300_000;
const commandTimeoutMs = 60_000;

// JSON.parse keeps every shape opaque to the compiler, so no cache row starts
// seeded. Every shape `readZ` sees keeps `z` in its first slot, so after the
// first one fills the row, the others hit through the slot without a miss.
const SITES_SOURCE = `const parse = (text: string): any => JSON.parse(text);
const narrow = process.argv[2] === "narrow";

function readX(point: { x: number }): number {
	return point.x;
}

function readY(point: { y: number }): number {
	return point.y;
}

function readZ(point: { z: number }): number {
	return point.z;
}

function label(value: object): string {
	return value.toString();
}

function tagOf(fn: any): number {
	return fn.tag;
}

function lookup(table: Record<string, number>, key: string): number {
	return table[key];
}

export function neverCalled(point: { w: number }): number {
	return point.w;
}

const shapes = {
	area(rect: { w: number; h: number }): number {
		return rect.w * rect.h;
	},
};

(readX as any).tag = 1;
// More properties than a shape holds keep the table's own properties in a dictionary.
const table: Record<string, number> = {};
for (let index = 0; index < 300; index++) table[\`k\${index}\`] = index;

let total = 0;
for (let round = 0; round < 3; round++) {
	total += readX(parse('{"x":1,"y":2}'));
	total += readY(parse('{"x":1,"y":2}'));
	if (!narrow) total += readY(parse('{"y":2,"x":1,"t":0}'));
	for (const suffix of ['', ',"a":0', ',"b":0', ',"c":0', ',"d":0', ',"e":0']) {
		total += readZ(parse(\`{"z":1\${suffix}}\`));
	}
	label(parse("{}"));
	total += tagOf(readX);
	total += lookup(table, \`k\${round}\`);
	total += [1, 2].map((n) => parse(\`{"n":\${n}}\`).n).length;
	total += shapes.area(parse('{"w":2,"h":3}'));
}
const top = parse('{"top":1}');
console.log(total + top.top);
`;

interface FeedbackFile {
	format: string;
	units: Array<string>;
	functions: Record<
		string,
		{
			module: string;
			revision: string;
			start: number;
			sites: Record<string, Array<{ units: Array<number> } & Record<string, unknown>>>;
		}
	>;
}

function invokeCli(cwd: string, args: ReadonlyArray<string>, timeout = commandTimeoutMs) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env: cleanTestEnvironment(),
		encoding: "utf8",
		timeout,
	});
}

describe("maligator run --feedback", () => {
	let directory: string;
	let feedbackPath: string;
	let first: ReturnType<typeof invokeCli>;
	let recorded: FeedbackFile;

	function record(entry: string, ...programArgs: Array<string>): FeedbackFile {
		const result = invokeCli(directory, [
			"run",
			entry,
			"--feedback",
			feedbackPath,
			...(programArgs.length === 0 ? [] : ["--", ...programArgs]),
		]);
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(readFileSync(feedbackPath, "utf8")) as FeedbackFile;
	}

	/** The sites of the function, or module body, starting at `start` in `entry`, by `op:key`. */
	function sitesFrom(file: FeedbackFile, entry: string, start: number) {
		const fn = Object.values(file.functions).find(
			(candidate) => candidate.module === entry && candidate.start === start,
		);
		if (fn === undefined) return undefined;
		return new Map(
			Object.entries(fn.sites).map(([key, entries]) => [
				key.slice(key.indexOf(":") + 1),
				entries.map(({ units, ...value }) => ({
					units: units.map((index) => file.units[index]),
					...value,
				})),
			]),
		);
	}

	function sitesAt(file: FeedbackFile, entry: string, marker: string) {
		const start = SITES_SOURCE.indexOf(marker);
		expect(start).toBeGreaterThanOrEqual(0);
		return sitesFrom(file, entry, start);
	}

	const sitesOf = (file: FeedbackFile, entry: string, name: string) =>
		sitesAt(file, entry, `function ${name}(`);

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "mal-cli-feedback-"));
		feedbackPath = join(directory, "feedback.json");
		writeFileSync(join(directory, "package.json"), '{ "type": "module" }\n');
		writeFileSync(join(directory, "sites.ts"), SITES_SOURCE);
		writeFileSync(join(directory, "other.ts"), SITES_SOURCE);
		mkdirSync(join(directory, "nested"));
		first = invokeCli(
			directory,
			["run", "sites.ts", "--feedback", feedbackPath],
			coldRunnerTimeoutMs,
		);
		expect(first.error, first.stderr).toBeUndefined();
		expect(first.status, first.stderr).toBe(0);
		recorded = JSON.parse(readFileSync(feedbackPath, "utf8")) as FeedbackFile;
	}, coldRunnerTimeoutMs + 5000);
	afterAll(() => {
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	});

	it("records the shapes each executed property site saw", () => {
		expect(recorded.units).toEqual(["run:sites.ts"]);
		expect(sitesOf(recorded, "sites.ts", "readX")).toEqual(
			new Map([["get:x", [{ units: ["run:sites.ts"], shapes: [["x", "y"]] }]]]),
		);
		expect(sitesOf(recorded, "sites.ts", "readY")).toEqual(
			new Map([
				[
					"get:y",
					[
						{
							units: ["run:sites.ts"],
							shapes: [
								["x", "y"],
								["y", "x", "t"],
							],
						},
					],
				],
			]),
		);
	});

	it("counts the shapes that hit through the cached slot, up to megamorphic", () => {
		expect(sitesOf(recorded, "sites.ts", "readZ")).toEqual(
			new Map([["get:z", [{ units: ["run:sites.ts"], megamorphic: true }]]]),
		);
	});

	it("records an inherited method site with its receiver shape", () => {
		expect(sitesOf(recorded, "sites.ts", "label")).toEqual(
			new Map([
				["get:toString", [{ units: ["run:sites.ts"], mode: "inherited", shapes: [[]] }]],
			]),
		);
	});

	it("names a function receiver's kind and its keys' non-default attributes", () => {
		expect(sitesOf(recorded, "sites.ts", "tagOf")?.get("get:tag")).toEqual([
			{
				units: ["run:sites.ts"],
				kind: "function",
				// Built-in function properties such as `name` are not writable.
				shapes: [expect.arrayContaining(["tag", [expect.any(String), "c"]])],
			},
		]);
	});

	it("records a dictionary receiver as a dictionary site", () => {
		expect(sitesOf(recorded, "sites.ts", "lookup")).toEqual(
			new Map([["get:*", [{ units: ["run:sites.ts"], dictionary: true }]]]),
		);
	});

	it("records anonymous callbacks, object literal methods and module top-level code", () => {
		expect(sitesAt(recorded, "sites.ts", "(n) =>")?.get("get:n")).toEqual([
			{ units: ["run:sites.ts"], shapes: [["n"]] },
		]);
		expect(sitesAt(recorded, "sites.ts", "(rect:")?.get("get:w")).toEqual([
			{ units: ["run:sites.ts"], shapes: [["w", "h"]] },
		]);
		expect(sitesFrom(recorded, "sites.ts", 0)?.get("get:top")).toEqual([
			{ units: ["run:sites.ts"], shapes: [["top"]] },
		]);
	});

	it("leaves functions that never ran out of the file", () => {
		expect(sitesOf(recorded, "sites.ts", "neverCalled")).toBeUndefined();
	});

	it("writes identical bytes for an identical run", () => {
		const before = readFileSync(feedbackPath, "utf8");
		record("sites.ts");
		expect(readFileSync(feedbackPath, "utf8")).toBe(before);
	});

	it("records the same unit and module keys from a subdirectory", () => {
		const before = readFileSync(feedbackPath, "utf8");
		const result = invokeCli(join(directory, "nested"), [
			"run",
			"../sites.ts",
			"--feedback",
			feedbackPath,
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(feedbackPath, "utf8")).toBe(before);
	});

	it("keeps other units' entries and replaces the recorded unit's", () => {
		const both = record("other.ts");
		expect(both.units).toEqual(["run:other.ts", "run:sites.ts"]);
		expect(sitesOf(both, "sites.ts", "readY")?.get("get:y")).toEqual([
			{
				units: ["run:sites.ts"],
				shapes: [
					["x", "y"],
					["y", "x", "t"],
				],
			},
		]);

		const narrowed = record("other.ts", "narrow");
		expect(sitesOf(narrowed, "other.ts", "readY")?.get("get:y")).toEqual([
			{ units: ["run:other.ts"], shapes: [["x", "y"]] },
		]);
		expect(sitesOf(narrowed, "sites.ts", "readY")).toEqual(
			sitesOf(both, "sites.ts", "readY"),
		);
	});
});
