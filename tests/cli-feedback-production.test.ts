import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

const cliEntry = resolve("src/index.ts");
const commandTimeoutMs = 180_000;

const SITES_SOURCE = `class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	norm() {
		return Math.sqrt(this.x * this.x + this.y * this.y);
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
const parse = (text) => JSON.parse(text);
let total = 0;
for (let index = 0; index < 20; index++) {
	const point = new Point(index, index + 1);
	total += readX(point) + readX(parse('{"x":2,"y":3}'));
	setY(point, index);
	total += Math.round(point.norm());
	total += describe(index).length;
	total += lookup({ a: 1, b: 2 }, index % 2 ? "a" : "b");
	total += "hello world".split(" ").length + /o/g.exec("foo").index;
}
console.log(total);
`;

const OTHER_SOURCE = `function area(rect) {
	return rect.w * rect.h;
}
let sum = 0;
for (let index = 0; index < 10; index++) sum += area({ w: index, h: 2 });
console.log(sum);
`;

interface FeedbackFile {
	functions: Record<string, { sites: Record<string, unknown> }>;
}

interface FeedbackCounters {
	matched: number;
	stale: number;
	recordedSites: number;
	attachedAfterConstruction: number;
}

function invokeCli(cwd: string, args: ReadonlyArray<string>) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env: cleanTestEnvironment(),
		encoding: "utf8",
		timeout: commandTimeoutMs,
	});
}

function succeed(result: ReturnType<typeof invokeCli>): string {
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
	return `${result.stdout}${result.stderr}`;
}

function project(sources: Record<string, string>): string {
	const directory = mkdtempSync(join(tmpdir(), "maligator-feedback-build-"));
	writeFileSync(join(directory, "package.json"), '{ "private": true }\n');
	for (const [name, source] of Object.entries(sources))
		writeFileSync(join(directory, name), source);
	return directory;
}

function record(directory: string, entry: string): string {
	succeed(invokeCli(directory, ["run", entry, "--feedback", "app.feedback.json"]));
	return readFileSync(join(directory, "app.feedback.json"), "utf8");
}

function feedbackCounters(output: string): FeedbackCounters {
	const match =
		/Core feedback: (\d+) functions matched\/(\d+) stale\/\d+ absent, (\d+) recorded sites, (\d+) attached after construction/.exec(
			output,
		);
	expect(match, output).not.toBeNull();
	const [, matched, stale, recordedSites, attachedAfterConstruction] = match!.map(Number);
	return {
		matched: matched!,
		stale: stale!,
		recordedSites: recordedSites!,
		attachedAfterConstruction: attachedAfterConstruction!,
	};
}

function propertySiteCount(file: FeedbackFile): number {
	return Object.values(file.functions)
		.flatMap((fn) => Object.keys(fn.sites))
		.filter((site) => /^\d+:(get|set):/.test(site)).length;
}

describe("maligator build --production --feedback", { timeout: 600_000 }, () => {
	const directories: Array<string> = [];
	let recorded: string;

	beforeAll(() => {
		const directory = project({ "main.js": SITES_SOURCE });
		directories.push(directory);
		recorded = record(directory, "main.js");
	});

	afterAll(() => {
		for (const directory of directories)
			rmSync(directory, { recursive: true, force: true });
	});

	function projectWithFeedback(source: string, feedback: string): string {
		const directory = project({ "main.js": source, "app.feedback.json": feedback });
		directories.push(directory);
		return directory;
	}

	it("attaches every recorded property site of a matching file to Core", () => {
		const directory = projectWithFeedback(SITES_SOURCE, recorded);
		const counters = feedbackCounters(
			succeed(
				invokeCli(directory, [
					"build",
					"main.js",
					"--production",
					"--feedback",
					"app.feedback.json",
					"--core-report",
					"counters",
				]),
			),
		);
		const file = JSON.parse(recorded) as FeedbackFile;
		expect(counters).toEqual({
			matched: Object.keys(file.functions).length,
			stale: 0,
			recordedSites: propertySiteCount(file),
			attachedAfterConstruction: propertySiteCount(file),
		});
	});

	// A revision covers the function's text, so the enclosing module body goes stale too.
	it("drops the feedback of an edited function and its enclosing module body as stale", () => {
		const edited = SITES_SOURCE.replace("return point.x;", "return point.x + 0;");
		expect(edited).not.toBe(SITES_SOURCE);
		const directory = projectWithFeedback(edited, recorded);
		const counters = feedbackCounters(
			succeed(
				invokeCli(directory, [
					"build",
					"main.js",
					"--production",
					"--feedback",
					"app.feedback.json",
					"--core-report",
					"counters",
				]),
			),
		);
		expect(counters.stale).toBe(2);
		expect(counters.matched).toBe(
			Object.keys((JSON.parse(recorded) as FeedbackFile).functions).length - 2,
		);
	});

	let foreign: string | undefined;
	function foreignFeedback(): string {
		if (foreign !== undefined) return foreign;
		const other = project({ "other.js": OTHER_SOURCE });
		directories.push(other);
		return (foreign = record(other, "other.js"));
	}

	function frontendCache(directory: string, feedback: ReadonlyArray<string>): string {
		const output = succeed(
			invokeCli(directory, [
				"build",
				"main.js",
				"--production",
				"--verbose",
				...feedback,
			]),
		);
		const cache = /Frontend cache: (hit|miss)/.exec(output);
		expect(cache, output).not.toBeNull();
		return cache![1]!;
	}

	it("generates the same C for feedback that matches nothing", () => {
		const directory = projectWithFeedback(SITES_SOURCE, foreignFeedback());
		const printed = (feedback: ReadonlyArray<string>) =>
			invokeCli(directory, ["build", "main.js", "--production", "--print", ...feedback]);
		const generated = printed([]);
		succeed(generated);
		expect(generated.stdout.length).toBeGreaterThan(0);
		const generatedWithFeedback = printed(["--feedback", "app.feedback.json"]);
		succeed(generatedWithFeedback);
		expect(generatedWithFeedback.stdout).toBe(generated.stdout);
	});

	it("shares the build identity of a build without feedback when nothing matches", () => {
		const directory = projectWithFeedback(SITES_SOURCE, foreignFeedback());
		expect(frontendCache(directory, ["--feedback", "app.feedback.json"])).toBe("miss");
		expect(frontendCache(directory, [])).toBe("hit");
	});

	it("gives matching feedback its own build identity that repeat builds reuse", () => {
		const directory = projectWithFeedback(SITES_SOURCE, recorded);
		expect(frontendCache(directory, ["--feedback", "app.feedback.json"])).toBe("miss");
		expect(frontendCache(directory, ["--feedback", "app.feedback.json"])).toBe("hit");
		expect(frontendCache(directory, [])).toBe("miss");
	});

	it("rejects a file that is not in the feedback format", () => {
		const directory = projectWithFeedback(SITES_SOURCE, '{ "format": "other" }\n');
		const result = invokeCli(directory, [
			"build",
			"main.js",
			"--production",
			"--feedback",
			"app.feedback.json",
		]);
		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("maligator-feedback-v1");
	});
});
