import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const project = mkdtempSync(path.join(os.tmpdir(), "mal-development-fragments-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

const dependency = path.join(project, "node_modules", "tiny-dep");
mkdirSync(dependency, { recursive: true });
writeFileSync(
	path.join(dependency, "package.json"),
	JSON.stringify({ name: "tiny-dep", type: "module", main: "index.js" }),
);
writeFileSync(
	path.join(dependency, "index.js"),
	[
		"export function sum(values) { let total = 0; for (const value of values) total += value; return total; }",
		"export class Counter { #count = 0; increment() { return ++this.#count; } }",
		"export async function later(value) { await null; return value * 2; }",
		"export function* pairs(limit) { for (let i = 0; i < limit; i++) yield [i, i * i]; }",
		"export let calls = 0;",
		"export function track() { calls++; }",
	].join("\n"),
);
writeFileSync(
	path.join(project, "maligator.build.ts"),
	'export default { entry: "main.mjs", outputName: "fragments", surface: { node: true } };\n',
);

function writeApplication(extra: string): void {
	writeFileSync(
		path.join(project, "main.mjs"),
		[
			'import { Counter, calls, later, pairs, sum, track } from "tiny-dep";',
			'import * as dependency from "tiny-dep";',
			"const counter = new Counter();",
			"counter.increment();",
			"const squares = [...pairs(4)].map(([, square]) => square);",
			"track();",
			"console.log(sum(squares), counter.increment(), await later(21), calls, dependency.calls);",
			extra,
		].join("\n"),
	);
}

function build(cwd = project): string {
	const result = spawnSync(
		process.execPath,
		[path.join(repositoryRoot, "src/index.ts"), "build", "--verbose"],
		{
			cwd,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: 600_000,
		},
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return `${result.stdout}\n${result.stderr}`;
}

function runBinary(cwd = project, name = "fragments"): string {
	const directory = path.join(cwd, ".cache/mal-build/development");
	const binary = readdirSync(directory).find((file) =>
		new RegExp(`^${name}-[0-9a-f]+$`).test(file),
	);
	expect(binary).toBeDefined();
	const result = spawnSync(path.join(directory, binary!), [], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

/** Generated objects the build compiled instead of reusing. */
function compiledUnits(output: string): Array<string> {
	return [...output.matchAll(/Generated C object · \w+ · (\S+): miss/g)].map(
		(match) => match[1]!,
	);
}

describe("development builds from relocatable fragments", () => {
	it("runs the application with each image's native overlay", () => {
		writeApplication("");
		build();
		expect(runBinary()).toBe("14 2 42 1 1\n");
	});

	it("recompiles only the edited application's image after a function is added", () => {
		writeApplication("const extra = (value) => value * 4;\nconsole.log(extra(5));");
		const output = build();
		const compiled = compiledUnits(output);
		expect(runBinary()).toBe("14 2 42 1 1\n20\n");

		expect(output).toMatch(/Development fragments: [1-9]\d* reused, 1 compiled/);

		const fragments = new Set(
			compiled
				.filter((unit) => unit !== "development-fragment-images")
				.map(
					(unit) =>
						/^fragment_(f[0-9a-f]+)-/.exec(unit)?.[1] ??
						/^development-fragment-image-(f[0-9a-f]+)$/.exec(unit)?.[1],
				),
		);
		expect(compiled).toContain("development-fragment-images");
		expect([...fragments]).toHaveLength(1);
		expect(fragments.has(undefined)).toBe(false);
	});

	it("runs worker roots through the compiled worker registry", () => {
		const workers = path.join(project, "workers");
		mkdirSync(workers, { recursive: true });
		for (const file of ["main.mjs", "jobs.mjs"])
			copyFileSync(
				path.join(repositoryRoot, "tests/local/worker-math-cache", file),
				path.join(workers, file),
			);
		writeFileSync(
			path.join(workers, "maligator.build.ts"),
			'export default { entry: "main.mjs", outputName: "workers", engine: { primordials: "mutable" } };\n',
		);
		build(workers);
		expect(runBinary(workers, "workers")).toBe("worker-math-cache PASS\n");
	});

	it("embeds configured assets in units an asset edit alone recompiles", () => {
		const assets = path.join(project, "assets");
		mkdirSync(assets, { recursive: true });
		const greeting = path.join(assets, "greeting.txt");
		writeFileSync(greeting, "hello from an asset\n");
		writeFileSync(
			path.join(assets, "main.mjs"),
			'import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(mal.assets.materialize("greeting"), "utf-8"));\n',
		);
		writeFileSync(
			path.join(assets, "maligator.build.ts"),
			'export default { entry: "main.mjs", outputName: "assets", surface: { node: true }, assets: { greeting: { type: "file", path: "greeting.txt" } } };\n',
		);
		const runWithoutSource = () => {
			renameSync(greeting, `${greeting}.hidden`);
			try {
				return runBinary(assets, "assets");
			} finally {
				renameSync(`${greeting}.hidden`, greeting);
			}
		};

		expect(build(assets)).toMatch(
			/Generated C object · data · development-fragment-assets: (?:hit|miss)/,
		);
		expect(runWithoutSource()).toBe("hello from an asset\n");

		// Unique text keeps CI's restored object cache from already holding the edited units.
		const edit = `edited asset ${randomUUID()}\n`;
		writeFileSync(greeting, edit);
		const edited = build(assets);
		expect(compiledUnits(edited).sort()).toEqual([
			"development-fragment-asset-0",
			"development-fragment-assets",
		]);
		expect(runWithoutSource()).toBe(edit);
	});
});
