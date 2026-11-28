import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

const cliEntry = resolve("src/index.ts");
const coldRunnerTimeoutMs = 300_000;
const commandTimeoutMs = 60_000;

// JSON.parse keeps every shape opaque to the compiler, so no cache row starts
// seeded. Each `z` sits at another slot, so every shape misses the row.
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

export function neverCalled(point: { w: number }): number {
	return point.w;
}

let total = 0;
for (let round = 0; round < 3; round++) {
	total += readX(parse('{"x":1,"y":2}'));
	total += readY(parse('{"x":1,"y":2}'));
	if (!narrow) total += readY(parse('{"y":2,"x":1,"t":0}'));
	for (const prefix of ['', '"a":0,', '"a":0,"b":0,', '"a":0,"b":0,"c":0,', '"a":0,"b":0,"c":0,"d":0,']) {
		total += readZ(parse(\`{\${prefix}"z":1}\`));
	}
	label(parse("{}"));
}
console.log(total);
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

	/** The sites of the function declared as `name` in `entry`, by `op:key`. */
	function sitesOf(file: FeedbackFile, entry: string, name: string) {
		const start = SITES_SOURCE.indexOf(`function ${name}(`);
		const fn = Object.values(file.functions).find(
			(candidate) =>
				candidate.module === join(directory, entry) && candidate.start === start,
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

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "mal-cli-feedback-"));
		feedbackPath = join(directory, "feedback.json");
		writeFileSync(join(directory, "package.json"), '{ "type": "module" }\n');
		writeFileSync(join(directory, "sites.ts"), SITES_SOURCE);
		writeFileSync(join(directory, "other.ts"), SITES_SOURCE);
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

	it("records the shapes, modes and megamorphic state of each executed property site", () => {
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
		expect(sitesOf(recorded, "sites.ts", "readZ")).toEqual(
			new Map([["get:z", [{ units: ["run:sites.ts"], megamorphic: true }]]]),
		);
		expect(sitesOf(recorded, "sites.ts", "label")).toEqual(
			new Map([["get:toString", [{ units: ["run:sites.ts"], mode: "inherited" }]]]),
		);
	});

	it("leaves functions that never ran out of the file", () => {
		expect(sitesOf(recorded, "sites.ts", "neverCalled")).toBeUndefined();
	});

	it("writes identical bytes for an identical run", () => {
		const before = readFileSync(feedbackPath, "utf8");
		record("sites.ts");
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
