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
	{
		name: "call targets and primitive receivers",
		source: `function Layer(path) {
	this.path = path;
}
Layer.prototype.match = function (path) {
	return this.path === path;
};
function matchAll(layers, path) {
	let count = 0;
	for (const layer of layers) if (layer.match(path)) count++;
	return count;
}
function run(callback, value) {
	return callback(value);
}
const app = function () {};
app.handle = function (value) {
	return value + 1;
};
const max = Math.max;
const steps = [(v) => v + 1, (v) => v * 2, (v) => v - 3, (v) => v % 5, (v) => -v];
const layers = [new Layer("/a"), new Layer("/b")];
const out = [];
for (let index = 0; index < 30; index++) {
	out.push(matchAll(layers, index % 2 ? "/a" : "/b"));
	out.push(run(steps[index % steps.length], index) + run((v) => v + index, 1));
	out.push(max(index, 7) + app.handle(index));
	out.push("a-b-c".indexOf("b") + String(index).padStart(3, "0").length);
	out.push(run(index % 2 ? Math.abs : Math.sign, -index));
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
const KINDS = [undefined, "function", "array", "error", "string", "number"];
const TARGET_POOL = [
	"builtin:Math.max",
	"builtin:String.prototype.indexOf",
	"builtin:Array.prototype.push",
	`fn:${"a".repeat(64)}:${"b".repeat(64)}`,
];

const isCallSite = (siteKey: string) => siteKey.includes(":call:");

/** 1 to 4 target names from the pool and `known`, or megamorphic targets. */
function randomTargets(next: () => number, known: ReadonlyArray<string>): SiteValue {
	if (next() < 0.2) return { targetsMegamorphic: true };
	const pool = [...TARGET_POOL, ...known];
	const names = new Set(
		Array.from(
			{ length: 1 + Math.floor(next() * 4) },
			() => pool[Math.floor(next() * pool.length)]!,
		),
	);
	return { targets: [...names].sort() };
}

function randomValue(
	next: () => number,
	siteKey: string,
	known: ReadonlyArray<string>,
): SiteValue {
	if (isCallSite(siteKey)) return randomTargets(next, known);
	const targets = next() < 0.3 ? randomTargets(next, known) : {};
	return { ...randomPropertyValue(next), ...targets };
}

function randomPropertyValue(next: () => number): SiteValue {
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

/** Each site's first value, property and call sites apart: neither op accepts the other's. */
function siteValues(file: FeedbackFile): {
	property: Array<SiteValue>;
	call: Array<SiteValue>;
} {
	const values = { property: [] as Array<SiteValue>, call: [] as Array<SiteValue> };
	for (const fn of Object.values(file.functions))
		for (const [siteKey, entries] of Object.entries(fn.sites)) {
			const { units: _units, ...value } = entries[0]!;
			values[isCallSite(siteKey) ? "call" : "property"].push(value);
		}
	return values;
}

function targetNames(file: FeedbackFile): Array<string> {
	return [
		...new Set(
			Object.values(file.functions).flatMap((fn) =>
				Object.values(fn.sites).flatMap((entries) =>
					entries.flatMap((entry) => (entry.targets as Array<string> | undefined) ?? []),
				),
			),
		),
	];
}

/** The `index`th value of the pool for the site's op, wrapping. */
function pooled(
	pools: { property: Array<SiteValue>; call: Array<SiteValue> },
	index: number,
	siteKey: string,
): SiteValue {
	const pool = pools[isCallSite(siteKey) ? "call" : "property"];
	if (pool.length === 0)
		return isCallSite(siteKey) ? { targetsMegamorphic: true } : { megamorphic: true };
	return pool[index % pool.length]!;
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
		let values: ReturnType<typeof siteValues> | undefined;
		return () => {
			if (values !== undefined) return values;
			const directory = project("foreign.js", FOREIGN_SOURCE);
			directories.push(directory);
			values = siteValues(record(directory, "foreign.js"));
			expect(values.property.length).toBeGreaterThan(0);
			return values;
		};
	})();

	it.each(FEEDBACK_FUZZ_FIXTURES)("$name", ({ source }) => {
		const directory = project("main.js", source);
		directories.push(directory);
		const recorded = record(directory, "main.js");
		const values = siteValues(recorded);
		expect(values.property.length).toBeGreaterThan(0);
		const known = targetNames(recorded);
		const expected = buildAndRun(directory, "main.js");
		expect(buildAndRun(directory, "main.js", recorded)).toBe(expected);

		const variants: Array<[string, FeedbackFile]> = [
			[
				"inverted",
				withSiteValues(recorded, (index, siteKey) => pooled(values, index + 1, siteKey)),
			],
			[
				"megamorphic",
				withSiteValues(recorded, (_index, siteKey) =>
					isCallSite(siteKey)
						? { targetsMegamorphic: true }
						: { megamorphic: true, targetsMegamorphic: true },
				),
			],
			[
				"foreign",
				withSiteValues(recorded, (index, siteKey) => pooled(foreign(), index, siteKey)),
			],
		];
		for (const seed of [1, 2, 3]) {
			const next = random(seed);
			variants.push([
				`random seed ${seed}`,
				withSiteValues(
					recorded,
					(_index, siteKey) => randomValue(next, siteKey, known),
					() =>
						Object.fromEntries(
							Array.from({ length: 3 }, () => {
								const op = ["get", "set", "call"][Math.floor(next() * 3)]!;
								const siteKey = `${Math.floor(next() * 400)}:${op}:${op === "call" ? "*" : KEY_POOL[Math.floor(next() * KEY_POOL.length)]}`;
								return [siteKey, randomValue(next, siteKey, known)];
							}),
						),
				),
			]);
		}
		for (const [variant, feedback] of variants)
			expect(buildAndRun(directory, "main.js", feedback), variant).toBe(expected);
	});
});
