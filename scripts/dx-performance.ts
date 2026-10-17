import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { CommandProgress } from "../src/command-progress.ts";
import { startDevelopmentDriver } from "./development-driver.ts";

interface Sample {
	name: string;
	durationMs: number;
	stdout: string;
	stderr: string;
	servedRevision?: number;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const requestedBinary = process.argv[2];
if (requestedBinary === undefined) {
	throw new Error(
		"usage: node scripts/dx-performance.ts <maligator-binary|--source> [--only run|test|dev] [--fresh-cache] [--assets] [--json-out PATH]",
	);
}
const sourceMode = requestedBinary === "--source";
const binary = sourceMode ? process.execPath : path.resolve(requestedBinary);
const argumentPrefix = sourceMode ? [path.join(repositoryRoot, "src/index.ts")] : [];
const options = process.argv.slice(3);
const onlyIndex = options.indexOf("--only");
const selectedLane = onlyIndex === -1 ? undefined : options[onlyIndex + 1];
if (
	selectedLane !== undefined &&
	selectedLane !== "run" &&
	selectedLane !== "test" &&
	selectedLane !== "dev"
) {
	throw new Error("--only requires run, test, or dev");
}
const outputIndex = options.indexOf("--json-out");
const output = outputIndex === -1 ? undefined : options[outputIndex + 1];
if (outputIndex !== -1 && (output === undefined || output.startsWith("--")))
	throw new Error("--json-out requires a file path");
const samples: Array<Sample> = [];
let complete = false;
let failure: string | undefined;
const persist = () => {
	if (output === undefined) return;
	mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
	writeFileSync(
		output,
		`${JSON.stringify({ schemaVersion: 1, complete, failure, host: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model }, sourceMode, selectedLane, freshCache: options.includes("--fresh-cache"), measureAssets: options.includes("--assets"), samples }, null, 2)}\n`,
	);
};
const measureAssets = options.includes("--assets");
const keepFixture = options.includes("--keep");
const root = mkdtempSync(path.join(os.tmpdir(), "maligator-dx-performance-"));
const childEnvironment = options.includes("--fresh-cache")
	? { ...process.env, MALIGATOR_CACHE_DIR: path.join(root, "user-cache") }
	: process.env;
const progress = new CommandProgress("bench-dx");
progress.start("create representative project and measure cold/warm workflows");
const project = path.join(root, "project");
const nodeModules = path.join(project, "node_modules");

function write(relativePath: string, source: string | Uint8Array): void {
	const file = path.join(project, relativePath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

function linkPackages(source: string): void {
	for (const name of readdirSync(source)) {
		if (name === ".bin") continue;
		const destination = path.join(nodeModules, name);
		try {
			symlinkSync(path.join(source, name), destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

function invoke(name: string, args: Array<string>): Sample {
	progress.detail(`${name} started`);
	const startedAt = performance.now();
	const result = spawnSync(binary, [...argumentPrefix, ...args], {
		cwd: project,
		encoding: "utf-8",
		env: childEnvironment,
		maxBuffer: 32 * 1024 * 1024,
		timeout: 180_000,
		killSignal: "SIGKILL",
	});
	const durationMs = performance.now() - startedAt;
	if (result.status !== 0) {
		const diagnostics = `${result.stdout}\n${result.stderr}`;
		throw new Error(
			`${name} exited with ${result.status}:\n${diagnostics.slice(-24_000)}`,
		);
	}
	progress.detail(`${name} completed in ${(durationMs / 1000).toFixed(1)}s`);
	const sample = { name, durationMs, stdout: result.stdout, stderr: result.stderr };
	samples.push(sample);
	persist();
	return sample;
}

async function developmentSamples(
	name: "dev cold served revision" | "dev cached served revision",
	measureEdit: boolean,
): Promise<Array<Sample>> {
	progress.detail(`${name} started`);
	const driver = startDevelopmentDriver(
		binary,
		[...argumentPrefix, "dev", "dev-app.mts", "--config", "maligator.build.mts"],
		{ cwd: project, env: childEnvironment },
	);
	let result: Array<Sample> | undefined;
	let failed: { error: unknown } | undefined;
	try {
		const readyMs = await driver.waitForRevision(0);
		progress.detail(`${name} completed in ${(readyMs / 1000).toFixed(1)}s`);
		result = [
			{
				name,
				durationMs: readyMs,
				stdout: driver.stdout,
				stderr: driver.stderr,
				servedRevision: 0,
			},
		];
		if (measureEdit) {
			const beforeStdout = driver.stdout.length;
			const beforeStderr = driver.stderr.length;
			write("local.mts", "export const localRevision = 1;\n");
			const rebuildMs = await driver.waitForRevision(1);
			progress.detail(
				`development leaf edit completed in ${(rebuildMs / 1000).toFixed(1)}s`,
			);
			result.push({
				name: "dev leaf edit",
				durationMs: rebuildMs,
				stdout: driver.stdout.slice(beforeStdout),
				stderr: driver.stderr.slice(beforeStderr),
				servedRevision: 1,
			});
		}
	} catch (error) {
		failed = { error };
	}
	try {
		await driver.stop();
	} catch (error) {
		failed = {
			error:
				failed === undefined
					? error
					: new AggregateError(
							[failed.error, error],
							"development probe and cleanup failed",
						),
		};
	}
	if (failed !== undefined)
		throw new Error(
			`${failed.error instanceof Error ? failed.error.message : String(failed.error)}\n${driver.output}`,
			{ cause: failed.error },
		);
	return result!;
}

const SUITE_FILES = 20;
const LIBRARY_MODULES = 30;

/** A chain of application modules, so each test reaches a different slice of it. */
function libraryModule(index: number, revision: number): string {
	const previous =
		index === 0 ? "" : `import { value${index - 1} } from "./module-${index - 1}.mts";\n`;
	const base = index === 0 ? "1" : `value${index - 1}() + 1`;
	return `${previous}export function value${index}(): number {
	return ${base};
}
export const label${index} = "module ${index} revision ${revision}";
`;
}

function suiteTest(index: number, revision: number, namespaced = false): string {
	const module = (index * 7) % LIBRARY_MODULES;
	return `import { describe, expect, test } from "maligator:test";
import { literal, object, parse } from "valibot";
${namespaced ? 'import * as path from "node:path";\n' : ""}import { label${module}, value${module} } from "../lib/module-${module}.mts";

describe("unit ${index}", () => {
	test("reads the library", () => {
		expect(value${module}()).toBe(${module + 1});
		expect(label${module}).toContain("module ${module}");
	});
	test("parses with a dependency", () => {
		expect(parse(object({ status: literal("ok") }), { status: "ok" })).toEqual({ status: "ok" });
	});${
		namespaced
			? `
	test("uses a namespace import", () => {
		expect(path.basename("/a/b.txt")).toBe("b.txt");
	});`
			: ""
	}
});
// revision ${revision}
`;
}

function report(sample: Sample): void {
	const detailPrefixes = [
		"Frontend cache:",
		"Frontend phases:",
		"Development fragments:",
		"Compiler phase ·",
		"Timing:",
		"Artifacts:",
		"Frontend:",
	];
	const details = `${sample.stdout}\n${sample.stderr}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => detailPrefixes.some((prefix) => line.startsWith(prefix)))
		.join(" · ");
	console.log(
		`${sample.name.padEnd(30)} ${sample.durationMs.toFixed(1).padStart(8)} ms${
			details === "" ? "" : ` · ${details}`
		}`,
	);
}

try {
	mkdirSync(nodeModules, { recursive: true });
	linkPackages(path.join(repositoryRoot, "node_modules"));
	write("package.json", `{"type":"module","private":true}\n`);
	write("local.mts", "export const localRevision = 0;\n");
	write(
		"app.mts",
		`import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import express from "express";
import { literal, object, parse } from "valibot";
import { localRevision } from "./local.mts";

const client = new DatabaseSync(":memory:");
const database = drizzle({ client });
database.run(sql\`create table message (value text not null)\`);
const response = parse(object({ status: literal("ok") }), { status: "ok" });
console.log(typeof express(), response.status, localRevision);
`,
	);
	write(
		"maligator.build.mts",
		`export default { entry: "app.mts", surface: { node: true, webPlatform: true } };\n`,
	);
	write(
		"dev-app.mts",
		`import "./app.mts";
import { createServer } from "node:http";
import { ready } from "maligator:application";
import { localRevision } from "./local.mts";
const server = createServer((_request, response) => { response.end(String(localRevision)); });
server.listen(0, "127.0.0.1", () => {
	console.log("DX_HTTP_PORT " + server.address().port);
	ready();
});
`,
	);
	for (let index = 0; index < 100; index++) {
		write(`public/asset-${String(index).padStart(3, "0")}.txt`, `asset ${index}\n`);
	}
	write(
		"maligator.assets.build.mts",
		`export default {
	entry: "app.mts",
	assets: { public: { type: "directory", path: "public", include: ["**/*"] } },
		surface: { node: true, webPlatform: true },
};\n`,
	);
	write(
		"app.test.mts",
		`import { expect, test } from "maligator:test";
import { literal, object, parse } from "valibot";
import { localRevision } from "./local.mts";
test("representative graph", () => {
	expect(parse(object({ status: literal("ok") }), { status: "ok" })).toEqual({ status: "ok" });
	expect(localRevision).toBe(0);
});\n`,
	);

	for (let index = 0; index < LIBRARY_MODULES; index++) {
		write(`lib/module-${index}.mts`, libraryModule(index, 0));
	}
	for (let index = 0; index < SUITE_FILES; index++) {
		const name = `unit-${String(index).padStart(2, "0")}.test.mts`;
		write(`suite/${name}`, suiteTest(index, 0));
		write(`namespaced/${name}`, suiteTest(index, 0, index === 3));
	}

	persist();
	if (selectedLane === undefined || selectedLane === "run") {
		invoke("run cold", [
			"run",
			"app.mts",
			"--config",
			"maligator.build.mts",
			"--verbose",
		]);
		invoke("run hot", ["run", "app.mts", "--config", "maligator.build.mts", "--verbose"]);
	}
	if (selectedLane === undefined || selectedLane === "test") {
		invoke("test cold", ["test", "app.test.mts", "--config", "maligator.build.mts"]);
		invoke("test hot", ["test", "app.test.mts", "--config", "maligator.build.mts"]);
		const suite = ["test", "suite", "--config", "maligator.build.mts"];
		invoke("suite cold", suite);
		invoke("suite hot", suite);
		write("suite/unit-07.test.mts", suiteTest(7, 1));
		invoke("suite test edit", suite);
		write("lib/module-29.mts", libraryModule(29, 1));
		invoke("suite library edit", suite);
		write("suite/unit-07.test.mts", suiteTest(7, 2));
		invoke("suite single file after edit", [
			"test",
			"suite/unit-07.test.mts",
			"--config",
			"maligator.build.mts",
		]);
		invoke("suite after single file", suite);
		const namespaced = ["test", "namespaced", "--config", "maligator.build.mts"];
		invoke("namespace suite cold", namespaced);
		write("namespaced/unit-03.test.mts", suiteTest(3, 1, true));
		invoke("namespace suite test edit", namespaced);
	}
	if (selectedLane === undefined || selectedLane === "dev") {
		for (const sample of await developmentSamples("dev cold served revision", false)) {
			samples.push(sample);
			persist();
		}
		for (const sample of await developmentSamples("dev cached served revision", true)) {
			samples.push(sample);
			persist();
		}
	}
	if (measureAssets && (selectedLane === undefined || selectedLane === "run")) {
		invoke("assets cold", [
			"run",
			"app.mts",
			"--config",
			"maligator.assets.build.mts",
			"--verbose",
		]);
		invoke("assets hot", [
			"run",
			"app.mts",
			"--config",
			"maligator.assets.build.mts",
			"--verbose",
		]);
	}
	for (const sample of samples) report(sample);
	complete = true;
	persist();
	progress.complete();

	if (!measureAssets) {
		console.log("\nAdd --assets to measure the current native toolchain asset path.");
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
	throw error;
} finally {
	persist();
	if (keepFixture) console.log(`\nFixture retained at ${project}`);
	else rmSync(root, { recursive: true, force: true });
}
