import { execFile, spawn } from "node:child_process";
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
	memory?: PeakMemory;
}

/** Peak resident set sizes in bytes, sampled while a command or development window ran. */
interface PeakMemory {
	/** The Maligator CLI process: the compiler, and an in-process application. */
	cliRssBytes: number;
	/** Descendants running another executable, such as a packaged application runner. */
	applicationRssBytes: number;
	/** The CLI with all of its descendants, compiler workers included. */
	treeRssBytes: number;
}

const MEMORY_SAMPLE_MS = 100;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const requestedBinary = process.argv[2];
if (requestedBinary === undefined) {
	throw new Error(
		"usage: node scripts/dx-performance.ts <maligator-binary|--source> [--only run|test|dev] [--fresh-cache] [--assets] [--keep] [--json-out PATH]",
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
		`${JSON.stringify({ schemaVersion: 2, complete, failure, host: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model }, sourceMode, selectedLane, freshCache: options.includes("--fresh-cache"), measureAssets: options.includes("--assets"), samples }, null, 2)}\n`,
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

interface ProcessRow {
	pid: number;
	parent: number;
	rssBytes: number;
	command: string;
}

/** Read asynchronously, so sampling never delays the development driver's requests. */
async function processTable(): Promise<Array<ProcessRow>> {
	const stdout = await new Promise<string>((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], (error, output) => {
			resolve(error === null ? output : "");
		});
	});
	return stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return match === null
			? []
			: [
					{
						pid: Number(match[1]),
						parent: Number(match[2]),
						rssBytes: Number(match[3]) * 1024,
						// An exiting process is listed as `(name)`, without its directory.
						command: path.basename(match[4]!.trim().replace(/^\((.*)\)$/, "$1")),
					},
				];
	});
}

/**
 * Poll the process tree under `root` and keep the peak of each memory class. Polling
 * misses spikes shorter than the interval, so peaks are lower bounds; `ps` costs a
 * few milliseconds per sample.
 */
function startMemorySampler(root: () => number | undefined) {
	const peak: PeakMemory = { cliRssBytes: 0, applicationRssBytes: 0, treeRssBytes: 0 };
	let sampling = false;
	const sample = async () => {
		const pid = root();
		if (pid === undefined || sampling) return;
		sampling = true;
		const rows = await processTable().finally(() => {
			sampling = false;
		});
		const cli = rows.find((row) => row.pid === pid);
		if (cli === undefined) return;
		const children = new Map<number, Array<ProcessRow>>();
		for (const row of rows) {
			const siblings = children.get(row.parent);
			if (siblings === undefined) children.set(row.parent, [row]);
			else siblings.push(row);
		}
		let application = 0;
		let tree = cli.rssBytes;
		const pending = [...(children.get(pid) ?? [])];
		while (pending.length > 0) {
			const row = pending.pop()!;
			tree += row.rssBytes;
			if (row.command !== cli.command) application += row.rssBytes;
			pending.push(...(children.get(row.pid) ?? []));
		}
		peak.cliRssBytes = Math.max(peak.cliRssBytes, cli.rssBytes);
		peak.applicationRssBytes = Math.max(peak.applicationRssBytes, application);
		peak.treeRssBytes = Math.max(peak.treeRssBytes, tree);
	};
	const timer = setInterval(() => void sample(), MEMORY_SAMPLE_MS);
	return {
		/** The peaks since the last window, after which the next window starts. */
		window(): PeakMemory {
			const result = { ...peak };
			peak.cliRssBytes = 0;
			peak.applicationRssBytes = 0;
			peak.treeRssBytes = 0;
			return result;
		},
		stop(): void {
			clearInterval(timer);
		},
	};
}

async function invoke(name: string, args: Array<string>): Promise<Sample> {
	progress.detail(`${name} started`);
	const startedAt = performance.now();
	const child = spawn(binary, [...argumentPrefix, ...args], {
		cwd: project,
		env: childEnvironment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const sampler = startMemorySampler(() => child.pid);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
	let memory: PeakMemory | undefined;
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => {
			memory = sampler.window();
		});
		child.once("close", (code) => resolve(code));
	}).finally(() => {
		clearTimeout(timeout);
		sampler.stop();
	});
	const durationMs = performance.now() - startedAt;
	if (status !== 0) {
		const diagnostics = `${stdout}\n${stderr}`;
		throw new Error(`${name} exited with ${status}:\n${diagnostics.slice(-24_000)}`);
	}
	progress.detail(`${name} completed in ${(durationMs / 1000).toFixed(1)}s`);
	const sample: Sample = {
		name,
		durationMs,
		stdout,
		stderr,
		...(memory === undefined ? {} : { memory }),
	};
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
	const sampler = startMemorySampler(() => driver.pid);
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
				memory: sampler.window(),
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
				memory: sampler.window(),
			});
		}
	} catch (error) {
		failed = { error };
	}
	sampler.stop();
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

/** A leaf only the application imports; an edit keeps its exported names. */
function featureModule(revision: number): string {
	return `export const feature = "feature revision ${revision}";\n`;
}

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
	const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	const memory =
		sample.memory === undefined
			? ""
			: ` · peak RSS cli ${megabytes(sample.memory.cliRssBytes)}, application ${megabytes(sample.memory.applicationRssBytes)}, tree ${megabytes(sample.memory.treeRssBytes)}`;
	console.log(
		`${sample.name.padEnd(30)} ${sample.durationMs.toFixed(1).padStart(8)} ms${memory}${
			details === "" ? "" : ` · ${details}`
		}`,
	);
}

try {
	mkdirSync(nodeModules, { recursive: true });
	linkPackages(path.join(repositoryRoot, "node_modules"));
	write("package.json", `{"type":"module","private":true}\n`);
	write("local.mts", "export const localRevision = 0;\n");
	write("feature.mts", featureModule(0));
	write(
		"app.mts",
		`import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import express from "express";
import { literal, object, parse } from "valibot";
import { feature } from "./feature.mts";
import { label${LIBRARY_MODULES - 1}, value${LIBRARY_MODULES - 1} } from "./lib/module-${LIBRARY_MODULES - 1}.mts";
import { localRevision } from "./local.mts";

const client = new DatabaseSync(":memory:");
const database = drizzle({ client });
database.run(sql\`create table message (value text not null)\`);
const response = parse(object({ status: literal("ok") }), { status: "ok" });
console.log(typeof express(), response.status, localRevision, feature, value${LIBRARY_MODULES - 1}(), label${LIBRARY_MODULES - 1});
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
		"assets.mts",
		`import { embedDirectory } from "maligator:assets";
console.log(embedDirectory("./public").files().length);
`,
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
		await invoke("run cold", [
			"run",
			"app.mts",
			"--config",
			"maligator.build.mts",
			"--verbose",
		]);
		await invoke("run hot", [
			"run",
			"app.mts",
			"--config",
			"maligator.build.mts",
			"--verbose",
		]);
		write("feature.mts", featureModule(1));
		await invoke("run leaf edit", [
			"run",
			"app.mts",
			"--config",
			"maligator.build.mts",
			"--verbose",
		]);
	}
	if (selectedLane === undefined || selectedLane === "test") {
		await invoke("test cold", [
			"test",
			"app.test.mts",
			"--config",
			"maligator.build.mts",
		]);
		await invoke("test hot", ["test", "app.test.mts", "--config", "maligator.build.mts"]);
		const suite = ["test", "suite", "--config", "maligator.build.mts"];
		await invoke("suite cold", suite);
		await invoke("suite hot", suite);
		write("suite/unit-07.test.mts", suiteTest(7, 1));
		await invoke("suite test edit", suite);
		write("lib/module-29.mts", libraryModule(29, 1));
		await invoke("suite library edit", suite);
		write("suite/unit-07.test.mts", suiteTest(7, 2));
		await invoke("suite single file after edit", [
			"test",
			"suite/unit-07.test.mts",
			"--config",
			"maligator.build.mts",
		]);
		await invoke("suite after single file", suite);
		const namespaced = ["test", "namespaced", "--config", "maligator.build.mts"];
		await invoke("namespace suite cold", namespaced);
		write("namespaced/unit-03.test.mts", suiteTest(3, 1, true));
		await invoke("namespace suite test edit", namespaced);
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
		await invoke("assets cold", ["run", "assets.mts", "--verbose"]);
		await invoke("assets hot", ["run", "assets.mts", "--verbose"]);
	}
	for (const sample of samples) report(sample);
	complete = true;
	persist();
	progress.complete();

	if (!measureAssets) {
		console.log("\nAdd --assets to measure an embedded directory read in place.");
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
	throw error;
} finally {
	persist();
	if (keepFixture) console.log(`\nFixture retained at ${project}`);
	else rmSync(root, { recursive: true, force: true });
}
