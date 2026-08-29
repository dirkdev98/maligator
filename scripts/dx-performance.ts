import { spawn, spawnSync } from "node:child_process";
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

interface Sample {
	name: string;
	durationMs: number;
	stdout: string;
	stderr: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const requestedBinary = process.argv[2];
if (requestedBinary === undefined) {
	throw new Error(
		"usage: node scripts/dx-performance.ts <maligator-binary|--source> [--only run|test|dev] [--fresh-cache] [--assets]",
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
	});
	const durationMs = performance.now() - startedAt;
	if (result.status !== 0) {
		const diagnostics = `${result.stdout}\n${result.stderr}`;
		throw new Error(
			`${name} exited with ${result.status}:\n${diagnostics.slice(-24_000)}`,
		);
	}
	progress.detail(`${name} completed in ${(durationMs / 1000).toFixed(1)}s`);
	return { name, durationMs, stdout: result.stdout, stderr: result.stderr };
}

function waitFor(
	read: () => string,
	needle: string,
	timeoutMs = 120_000,
): Promise<number> {
	const startedAt = performance.now();
	return new Promise((resolve, reject) => {
		const interval = setInterval(() => {
			if (read().includes(needle)) {
				clearInterval(interval);
				clearTimeout(timeout);
				resolve(performance.now() - startedAt);
			}
		}, 2);
		const timeout = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${read()}`));
		}, timeoutMs);
	});
}

async function developmentSamples(
	name: "dev cold ready" | "dev cached ready",
	measureEdit: boolean,
): Promise<Array<Sample>> {
	progress.detail(`${name} started`);
	let output = "";
	const child = spawn(
		binary,
		[
			...argumentPrefix,
			"dev",
			"dev-app.mts",
			"--config",
			"maligator.build.mts",
			"--verbose",
		],
		{
			cwd: project,
			detached: process.platform !== "win32",
			env: childEnvironment,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		output += chunk;
	});
	try {
		const readyMs = await waitFor(() => output, "Ready in");
		progress.detail(`${name} completed in ${(readyMs / 1000).toFixed(1)}s`);
		const ready = { name, durationMs: readyMs, stdout: "", stderr: output };
		if (!measureEdit) return [ready];
		const beforeEdit = output;
		write("local.mts", "export const localRevision = 1;\n");
		const rebuildMs = await waitFor(() => output.slice(beforeEdit.length), "Compiled in");
		progress.detail(
			`development leaf edit completed in ${(rebuildMs / 1000).toFixed(1)}s`,
		);
		return [
			ready,
			{
				name: "dev leaf edit",
				durationMs: rebuildMs,
				stdout: "",
				stderr: output.slice(beforeEdit.length),
			},
		];
	} finally {
		if (child.exitCode === null) {
			if (process.platform !== "win32" && child.pid !== undefined) {
				process.kill(-child.pid, "SIGTERM");
			} else {
				child.kill("SIGTERM");
			}
		}
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
	}
}

function report(sample: Sample): void {
	const detailPrefixes = [
		"Frontend cache:",
		"Frontend phases:",
		"Development fragments:",
		"Compiler phase ·",
	];
	const details = sample.stderr
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
	linkPackages(path.join(repositoryRoot, "tests/fixtures/express-5/node_modules"));
	for (const name of ["drizzle-orm", "valibot"]) {
		symlinkSync(
			path.join(repositoryRoot, "node_modules", name),
			path.join(nodeModules, name),
		);
	}
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
	write("dev-app.mts", `import "./app.mts";\nsetInterval(() => {}, 1000);\n`);
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

	const samples: Array<Sample> = [];
	if (selectedLane === undefined || selectedLane === "run") {
		samples.push(
			invoke("run cold", [
				"run",
				"app.mts",
				"--config",
				"maligator.build.mts",
				"--verbose",
			]),
			invoke("run hot", [
				"run",
				"app.mts",
				"--config",
				"maligator.build.mts",
				"--verbose",
			]),
		);
	}
	if (selectedLane === undefined || selectedLane === "test") {
		samples.push(
			invoke("test cold", ["test", "app.test.mts", "--config", "maligator.build.mts"]),
			invoke("test hot", ["test", "app.test.mts", "--config", "maligator.build.mts"]),
		);
	}
	if (selectedLane === undefined || selectedLane === "dev") {
		for (const sample of await developmentSamples("dev cold ready", false)) {
			samples.push(sample);
		}
		for (const sample of await developmentSamples("dev cached ready", true)) {
			samples.push(sample);
		}
	}
	if (measureAssets && (selectedLane === undefined || selectedLane === "run")) {
		samples.push(
			invoke("assets cold", [
				"run",
				"app.mts",
				"--config",
				"maligator.assets.build.mts",
				"--verbose",
			]),
			invoke("assets hot", [
				"run",
				"app.mts",
				"--config",
				"maligator.assets.build.mts",
				"--verbose",
			]),
		);
	}
	for (const sample of samples) report(sample);
	progress.complete();

	if (!measureAssets) {
		console.log("\nAdd --assets to measure the current native toolchain asset path.");
	}
} finally {
	if (keepFixture) console.log(`\nFixture retained at ${project}`);
	else rmSync(root, { recursive: true, force: true });
}
