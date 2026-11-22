import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "mal-module-images-")));

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

function write(name: string, source: string): void {
	const file = path.join(directory, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

function node(): string {
	const result = spawnSync(process.execPath, ["entry.mjs"], {
		cwd: directory,
		encoding: "utf-8",
		timeout: 60_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

function run(command: "run" | "build"): { stdout: string; stderr: string } {
	const stderrPath = path.join(directory, "maligator.stderr.log");
	// Verbose diagnostics can exceed the child process buffer when compiling a runtime.
	const stderrFile = openSync(stderrPath, "w");
	let result;
	try {
		result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				command,
				"entry.mjs",
				"--config",
				"maligator.build.mjs",
				"--verbose",
			],
			{
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", stderrFile],
				timeout: 300_000,
			},
		);
	} finally {
		closeSync(stderrFile);
	}
	const stderr = readFileSync(stderrPath, "utf-8");
	const diagnostic = (stderr || result.stdout || "").slice(-8192);
	expect(result.error, diagnostic).toBeUndefined();
	expect(result.status, `${result.signal ?? ""}\n${diagnostic}`.trim()).toBe(0);
	if (command === "run") return { stdout: result.stdout, stderr };
	const binary = spawnSync(result.stdout.trim(), {
		cwd: directory,
		encoding: "utf-8",
		timeout: 60_000,
	});
	expect(binary.error, binary.stderr).toBeUndefined();
	expect(binary.status, binary.stderr).toBe(0);
	return { stdout: binary.stdout, stderr };
}

const { primordials, realms } = preparedNativeEvalConfig().engine;

/**
 * Every application module gets its own image here except where evaluation order
 * requires sharing: `cycle-a` and `cycle-b` import each other and only they reach
 * `between`, which evaluates between them; `suspends` awaits at top level, so
 * `after` must start before it resumes.
 */
const files = {
	"package.json": `{"type":"module"}\n`,
	// Use the eval compiler variant native setup has already built.
	"maligator.build.mjs": `export default {\n\tengine: { primordials: "${primordials}", realms: ${realms} },\n};\n`,
	"node_modules/counter/package.json": `{"type":"module","exports":"./index.js"}\n`,
	"node_modules/counter/index.js":
		"export let count = 0;\nexport function increment() { return ++count; }\n",
	"leaf.mjs": `import { increment } from "counter";\nconsole.log("leaf", increment());\nexport const leaf = "leaf revision 0";\n`,
	"cycle-a.mjs": `import { b } from "./cycle-b.mjs";\nimport "./between.mjs";\nconsole.log("cycle-a", typeof b);\nexport const a = () => "a";\n`,
	"cycle-b.mjs": `import { a } from "./cycle-a.mjs";\nconsole.log("cycle-b");\nexport const b = () => a();\n`,
	"between.mjs": `console.log("between");\n`,
	"suspends.mjs": `import { leaf } from "./leaf.mjs";\nawait new Promise((resolve) => setTimeout(resolve, 5));\nconsole.log("suspends", leaf);\n`,
	"after.mjs": `import { count, increment } from "counter";\nconsole.log("after", count, increment());\n`,
	"entry.mjs": `import { leaf } from "./leaf.mjs";\nimport { a } from "./cycle-a.mjs";\nimport "./suspends.mjs";\nimport "./after.mjs";\nconsole.log("entry", leaf, a());\n`,
};

function writeProject(): void {
	for (const [name, source] of Object.entries(files)) write(name, source);
}

describe.each(["run", "build"] as const)(
	"per-module images with maligator %s",
	(command) => {
		it("evaluates a cycle and its top-level-await siblings in Node's order", () => {
			writeProject();

			const { stdout, stderr } = run(command);

			expect(stdout).toBe(node());
			const fragments = /Development fragments: \d+ reused, (\d+) compiled/.exec(stderr);
			expect(Number(fragments?.[1])).toBeGreaterThan(2);
		}, 300_000);

		it("recompiles only the edited leaf's image", () => {
			writeProject();
			run(command);
			write("leaf.mjs", files["leaf.mjs"].replace("leaf revision 0", "leaf revision 1"));

			const { stdout, stderr } = run(command);

			expect(stdout).toBe(node());
			const fragments = /Development fragments: (\d+) reused, 1 compiled/.exec(stderr);
			expect(Number(fragments?.[1])).toBeGreaterThan(1);
		}, 300_000);
	},
);
