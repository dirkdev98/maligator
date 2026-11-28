import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

/**
 * Feedback is speculation: whatever a production build derives from it must keep
 * a generic fallback, so no feedback file can change what a program prints. Each
 * fixture is recorded in development, then built with feedback that lies about
 * every site it names. A consumer of feedback adds the fixture its fast paths
 * guard here.
 */
const FEEDBACK_FUZZ_FIXTURES: ReadonlyArray<{
	readonly name: string;
	readonly source: string;
}> = [
	{
		name: "property, method, string and regexp sites",
		source: `class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	norm() {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}
}
class Point3 extends Point {
	constructor(x, y, z) {
		super(x, y);
		this.z = z;
	}
	norm() {
		return super.norm() + this.z;
	}
}
function readX(point) {
	return point.x;
}
function setY(point, value) {
	point.y = value;
	return point;
}
function describe(value) {
	return value.toString();
}
function lookup(table, key) {
	return table[key];
}
function words(text) {
	return text.split(" ").map((word) => word.toUpperCase()).join("-");
}
function firstMatch(pattern, text) {
	const match = pattern.exec(text);
	return match === null ? -1 : match.index;
}
const parse = (text) => JSON.parse(text);
const table = {};
for (let index = 0; index < 40; index++) table["k" + index] = index;
const out = [];
for (let index = 0; index < 30; index++) {
	const point = index % 3 === 0 ? new Point3(index, 1, 2) : new Point(index, index + 1);
	out.push(readX(point) + readX(parse('{"y":3,"x":2}')) + readX({ x: index, w: 1 }));
	setY(point, index);
	setY(parse('{"x":1}'), index);
	out.push(Math.round(point.norm()));
	out.push(describe(index) + describe("s" + index) + describe([index, 1]));
	out.push(lookup(table, "k" + index) + lookup({ a: 1, b: 2 }, index % 2 ? "a" : "b"));
	out.push(words("hello wide world " + index));
	out.push(firstMatch(/o+/g, "foo boo " + index) + firstMatch(/z/, "abc"));
	out.push(String(lookup([1, 2, 3], index % 4)) + "abc".length + [index].length);
}
console.log(out.join(","));
`,
	},
];

const FOREIGN_SOURCE = `function area(rect) {
	return rect.w * rect.h;
}
const items = [{ w: 1, h: 2 }, { h: 1, w: 3, d: 0 }, Object.create({ w: 4, h: 1 })];
let sum = 0;
for (let index = 0; index < 20; index++) sum += area(items[index % 3]) + String(index).length;
console.log(sum, "a-b".split("-").length, /b/.test("abc"));
`;

const cliEntry = resolve("src/index.ts");
const commandTimeoutMs = 180_000;

type SiteValue = Record<string, unknown>;

interface FeedbackFile {
	format: string;
	units: Array<string>;
	functions: Record<
		string,
		{
			module: string;
			revision: string;
			start: number;
			sites: Record<string, Array<{ units: Array<number> } & SiteValue>>;
		}
	>;
}

function invokeCli(cwd: string, args: ReadonlyArray<string>) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env: cleanTestEnvironment(),
		encoding: "utf8",
		timeout: commandTimeoutMs,
	});
}

function succeed(result: ReturnType<typeof spawnSync>): string {
	expect(result.error, String(result.stderr)).toBeUndefined();
	expect(result.status, `${String(result.stdout)}${String(result.stderr)}`).toBe(0);
	return `${String(result.stdout)}${String(result.stderr)}`;
}

function project(entry: string, source: string): string {
	const directory = mkdtempSync(join(tmpdir(), "maligator-feedback-fuzz-"));
	writeFileSync(join(directory, "package.json"), '{ "private": true }\n');
	writeFileSync(join(directory, entry), source);
	return directory;
}

function record(directory: string, entry: string): FeedbackFile {
	succeed(invokeCli(directory, ["run", entry, "--feedback", "recorded.feedback.json"]));
	return JSON.parse(
		readFileSync(join(directory, "recorded.feedback.json"), "utf8"),
	) as FeedbackFile;
}

/** Build `entry` for production, optionally with `feedback`, run it and return its stdout. */
function buildAndRun(directory: string, entry: string, feedback?: FeedbackFile): string {
	const args = ["build", entry, "--production"];
	if (feedback !== undefined) {
		writeFileSync(
			join(directory, "variant.feedback.json"),
			`${JSON.stringify(feedback)}\n`,
		);
		args.push("--feedback", "variant.feedback.json", "--core-report", "counters");
	}
	const output = succeed(invokeCli(directory, args));
	// A variant that stopped matching the program would pass without testing anything.
	if (feedback !== undefined)
		expect(output).toMatch(
			/Core feedback: [1-9]\d* functions matched.* [1-9]\d* attached after construction/,
		);
	const built = /Built (\S+) in /.exec(output);
	expect(built).not.toBeNull();
	const run = spawnSync(built![1]!, [], {
		cwd: directory,
		encoding: "utf8",
		timeout: commandTimeoutMs,
	});
	succeed(run);
	return run.stdout;
}

// mulberry32: a fixed seed makes every variant reproducible from the test name.
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_POOL = ["x", "y", "z", "w", "h", "length", "index", "a", "b", "k0", "norm"];
const MODES = [
	"inherited",
	"primitive",
	"string-length",
	"transition",
	"missing",
	"watched",
];
const KINDS = [undefined, "function", "array", "error"];

function randomValue(next: () => number): SiteValue {
	const pick = <T>(values: ReadonlyArray<T>): T =>
		values[Math.floor(next() * values.length)]!;
	const shapes = () =>
		Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
			Array.from({ length: Math.floor(next() * 4) }, () =>
				next() < 0.8 ? pick(KEY_POOL) : [pick(KEY_POOL), pick(["c", "wc", "a", "ec"])],
			),
		);
	const kind = pick(KINDS);
	const kindPart = kind === undefined ? {} : { kind };
	switch (Math.floor(next() * 5)) {
		case 0:
			return { megamorphic: true };
		case 1:
			return { dictionary: true };
		case 2:
			return { mode: pick(MODES), shapes: shapes(), ...kindPart };
		case 3:
			return { mode: pick(MODES), ...kindPart };
		default:
			return { shapes: shapes(), ...kindPart };
	}
}

function siteValues(file: FeedbackFile): Array<SiteValue> {
	return Object.values(file.functions).flatMap((fn) =>
		Object.values(fn.sites).map((entries) => {
			const { units: _units, ...value } = entries[0]!;
			return value;
		}),
	);
}

/** `file` with every site's entries replaced by `valueFor(site index)`, units kept. */
function withSiteValues(
	file: FeedbackFile,
	valueFor: (index: number, siteKey: string) => SiteValue,
	extraSites: (origin: string) => Record<string, SiteValue> = () => ({}),
): FeedbackFile {
	let index = 0;
	const units = file.units.map((_, unit) => unit);
	return {
		...file,
		functions: Object.fromEntries(
			Object.entries(file.functions).map(([origin, fn]) => [
				origin,
				{
					...fn,
					sites: Object.fromEntries(
						[
							...Object.keys(fn.sites).map((siteKey): [string, SiteValue] => [
								siteKey,
								valueFor(index++, siteKey),
							]),
							...Object.entries(extraSites(origin)),
						].map(([siteKey, value]) => [siteKey, [{ units, ...value }]]),
					),
				},
			]),
		),
	};
}

describe("production builds ignore lying feedback", { timeout: 900_000 }, () => {
	const directories: Array<string> = [];
	afterAll(() => {
		for (const directory of directories)
			rmSync(directory, { recursive: true, force: true });
	});

	const foreign = (() => {
		let values: Array<SiteValue> | undefined;
		return () => {
			if (values !== undefined) return values;
			const directory = project("foreign.js", FOREIGN_SOURCE);
			directories.push(directory);
			values = siteValues(record(directory, "foreign.js"));
			expect(values.length).toBeGreaterThan(0);
			return values;
		};
	})();

	it.each(FEEDBACK_FUZZ_FIXTURES)("$name", ({ source }) => {
		const directory = project("main.js", source);
		directories.push(directory);
		const recorded = record(directory, "main.js");
		const values = siteValues(recorded);
		expect(values.length).toBeGreaterThan(0);
		const expected = buildAndRun(directory, "main.js");
		expect(buildAndRun(directory, "main.js", recorded)).toBe(expected);

		const variants: Array<[string, FeedbackFile]> = [
			[
				"inverted",
				withSiteValues(recorded, (index) => values[(index + 1) % values.length]!),
			],
			["megamorphic", withSiteValues(recorded, () => ({ megamorphic: true }))],
			[
				"foreign",
				withSiteValues(recorded, (index) => foreign()[index % foreign().length]!),
			],
		];
		for (const seed of [1, 2, 3]) {
			const next = random(seed);
			variants.push([
				`random seed ${seed}`,
				withSiteValues(
					recorded,
					() => randomValue(next),
					() =>
						Object.fromEntries(
							Array.from({ length: 2 }, () => [
								`${Math.floor(next() * 400)}:${next() < 0.5 ? "get" : "set"}:${KEY_POOL[Math.floor(next() * KEY_POOL.length)]}`,
								randomValue(next),
							]),
						),
				),
			]);
		}
		for (const [variant, feedback] of variants)
			expect(buildAndRun(directory, "main.js", feedback), variant).toBe(expected);
	});
});
