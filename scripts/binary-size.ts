import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { LocalBuildResult } from "../src/local-build.ts";
import type { NativeBuildCommandEvent } from "../src/native-build-context.ts";
import { buildNativeBinaryResult, HOST_MAIN } from "../src/test-harness.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const lean = resolveBuildConfig({});
const web = resolveBuildConfig({ surface: { webPlatform: true } });
const node = resolveBuildConfig({ surface: { node: true } });
const nodeWeb = resolveBuildConfig({ surface: { node: true, webPlatform: true } });
const fixtures = [
	{ name: "hello", file: "bench/size/hello.mjs", config: lean, bun: true },
	{ name: "serve", file: "bench/size/serve.mjs", config: web, bun: false },
	{ name: "fetch", file: "bench/size/fetch.mjs", config: web, bun: true },
	{ name: "node-hello", file: "bench/size/node-hello.mjs", config: node, bun: true },
	{ name: "node-fs", file: "bench/size/node-fs.mjs", config: node, bun: true },
	{ name: "http-bare", file: "bench/http/server_mal.js", config: web, bun: false },
	{ name: "express", file: "bench/http/express-server.cjs", config: nodeWeb, bun: true },
];

function rankedBytes(groups: Map<string, number>) {
	return [...groups]
		.map(([name, bytes]) => ({ name, bytes }))
		.sort(
			(left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name),
		);
}

function addBytes(groups: Map<string, number>, name: string, bytes: number): void {
	groups.set(name, (groups.get(name) ?? 0) + bytes);
}

function rustCrate(symbol: string): string | undefined {
	// Group under the crate that defined the item, including generic instances
	// emitted by another crate. Both Rust manglings length-prefix identifiers.
	const crate = /^_+R/.test(symbol)
		? /Cs[\da-zA-Z]+_(\d+)([\da-zA-Z_]+)/.exec(symbol)
		: /^_+ZN(\d+)(.+)17h[\da-f]{16}E(?:\b|$)/.exec(symbol);
	return crate?.[2]?.slice(0, Number(crate[1]));
}

function darwinAttribution(mapFile: string, built: LocalBuildResult) {
	const { c, rust } = built.artifacts;
	const archiveNames = new Map([
		[c.runtime, "libMalRuntime.a"],
		[c.host, "libMalHost.a"],
		[c.engine, "libLibMaligator.a"],
		[rust.library, "libmal_rust.a"],
	]);
	const originals = built.artifacts.linkArgs.filter(
		(argument) => !argument.startsWith("-"),
	);
	const byObject = new Map<string, number>();
	const byRustCrate = new Map<string, number>();
	const names = new Map<number, string>();
	const zeroFill: Array<{ address: number; end: number }> = [];
	let section = "";
	for (const line of readFileSync(mapFile, "utf8").split("\n")) {
		if (line.startsWith("#")) {
			if (!line.startsWith("# Address")) section = line;
			continue;
		}
		if (section === "# Object files:") {
			const entry = /^\[\s*(\d+)\]\s*(.*)$/.exec(line);
			if (entry === null) continue;
			const name = path.basename(entry[2]!);
			const archive = /^(\d+)\.a\((.+)\)$/.exec(name);
			const original = archive === null ? undefined : originals[Number(archive[1])];
			const unit = /^(\d+)\.o$/.exec(name);
			const generated =
				unit === null ? undefined : built.measurements.objects[Number(unit[1])];
			names.set(
				Number(entry[1]),
				archive !== null && original !== undefined
					? `${archiveNames.get(original) ?? path.basename(original)}(${archive[2]})`
					: (generated?.unit ?? (name || "<no input path>")),
			);
		}
		if (section === "# Sections:") {
			const range = /^(0x\w+)\s+(0x\w+)\s+\S+\s+__(?:bss|common|thread_bss)\s*$/.exec(
				line,
			);
			if (range === null) continue;
			const address = Number(range[1]);
			zeroFill.push({ address, end: address + Number(range[2]) });
		}
		if (section === "# Symbols:") {
			const entry = /^(0x\w+)\s+(0x\w+)\s+\[\s*(\d+)\]\s+(.+)$/.exec(line);
			if (entry === null) continue;
			const address = Number(entry[1]);
			const bytes = Number(entry[2]);
			if (
				bytes === 0 ||
				zeroFill.some((range) => range.address <= address && address < range.end)
			)
				continue;
			const object = names.get(Number(entry[3]));
			if (object === undefined)
				throw new Error(`Unknown object for map symbol ${entry[4]}`);
			addBytes(byObject, object, bytes);
			const crate = rustCrate(entry[4]!);
			if (crate !== undefined) addBytes(byRustCrate, crate, bytes);
		}
	}
	if (byObject.size === 0) throw new Error(`No linked symbols found in ${mapFile}`);
	return {
		mapFile: path.basename(mapFile),
		byObject: rankedBytes(byObject),
		byRustCrate: rankedBytes(byRustCrate),
	};
}

function replayWithMap(
	event: NativeBuildCommandEvent,
	scratch: string,
	mapFile: string,
	env: NodeJS.ProcessEnv,
): void {
	const { tool, args, cwd } = event;
	const output = args.at(-1);
	if (
		args.at(-2) !== "-o" ||
		output === undefined ||
		path.dirname(output) !== scratch ||
		!args.some((argument) => argument.endsWith(".a"))
	)
		return;

	// The harness reports this link while its temporary input objects still exist.
	// Replay those exact inputs so the size itself comes from the ordinary build.
	const original = path.join(scratch, "before-map");
	renameSync(output, original);
	try {
		execFileSync(tool, [...args, "-Xlinker", "-map", "-Xlinker", mapFile], {
			cwd,
			env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		if (!readFileSync(output).equals(readFileSync(original))) {
			throw new Error(`Link map replay changed the executable for ${output}`);
		}
	} finally {
		renameSync(original, output);
	}
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--plan=json") {
	console.log(JSON.stringify({ mode: "production", fixtures }, null, 2));
	process.exit(0);
}
if (args.length !== 0) throw new Error("usage: npm run bench:size -- [--plan=json]");

const reportRoot = path.resolve(".cache", "bench-size");
mkdirSync(reportRoot, { recursive: true });
const reportDirectory = mkdtempSync(path.join(reportRoot, "run-"));
const scratch = mkdtempSync(path.join(os.tmpdir(), "maligator-binary-size-"));
const env = cleanTestEnvironment({ LC_ALL: "C" });
const bun = spawnSync("bun", ["--version"], { encoding: "utf8", env });
const bunVersion = bun.status === 0 ? bun.stdout.trim() : undefined;
const results = [];
try {
	for (const fixture of fixtures) {
		const { name, file, config } = fixture;
		console.log(`Building ${name}`);
		const mapFile = path.join(reportDirectory, `${name}.map`);
		const collectMap = process.platform === "darwin";
		const built = buildNativeBinaryResult({
			fixture: file,
			name,
			config,
			mainFile: config.surface.webPlatform ? HOST_MAIN : undefined,
			production: true,
			outDir: scratch,
			environment: env,
			nativeLinkCacheVariant: collectMap ? randomUUID() : undefined,
			measureNativeBuildResources: collectMap,
			onNativeCommandResource: collectMap
				? (event) => replayWithMap(event, scratch, mapFile, env)
				: undefined,
		});
		const binaryBytes = statSync(built.binaryPath).size;
		const attribution = collectMap ? darwinAttribution(mapFile, built) : undefined;
		let bunBytes: number | undefined;
		if (fixture.bun && bunVersion !== undefined) {
			const outfile = path.join(scratch, `${name}-bun`);
			execFileSync("bun", ["build", "--compile", file, "--outfile", outfile], {
				env,
				stdio: ["ignore", "ignore", "pipe"],
			});
			bunBytes = statSync(outfile).size;
			rmSync(outfile);
		}
		const { tools, platform, rustTarget } = built.context.toolchain;
		results.push({
			name,
			file,
			config,
			binaryBytes,
			bunBytes,
			bunCompatible: fixture.bun,
			attribution,
			plan: built.context.plan,
			toolchain: { cc: tools.cc, rustc: tools.rustc, platform, rustTarget },
		});
		console.log(
			`  Maligator ${binaryBytes} bytes${bunBytes === undefined ? "" : `, Bun ${bunBytes} bytes`}`,
		);
		if (attribution !== undefined) {
			console.log(`  Link map ${mapFile}`);
			for (const [label, groups] of [
				["Objects", attribution.byObject],
				["Rust crates", attribution.byRustCrate],
			] as const) {
				if (groups.length > 0)
					console.log(
						`  ${label} ${groups
							.slice(0, 3)
							.map(({ name, bytes }) => `${name} (${bytes})`)
							.join(", ")}`,
					);
			}
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
	const report = path.join(reportDirectory, "report.json");
	writeFileSync(
		report,
		`${JSON.stringify(
			{
				platform: process.platform,
				arch: process.arch,
				bunVersion,
				complete: results.length === fixtures.length,
				results,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Report ${report}`);
}
