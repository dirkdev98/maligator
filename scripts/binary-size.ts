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
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const config = resolveBuildConfig({});

interface LinkedSymbol {
	object: string;
	symbol: string;
	crate: string | undefined;
	instruction: boolean;
	bytes: number;
	relocatedConstant: boolean;
}

const forbiddenComponents = {
	brotli: ({ crate }) => crate === "brotli" || crate === "brotli_decompressor",
	// Rust can merge identical codec tables under either crate's constant name.
	"Brotli encoder": ({ crate, symbol, instruction }) =>
		(instruction && crate === "brotli") || symbol === "_mal_zlib_create_brotli_encoder",
	"fs.Stats": ({ symbol }) => /^_node_fs_get_(?:a|m|c|birth)time(?:$|\.)/.test(symbol),
	"Date timezone data": ({ crate, symbol, bytes, object }) =>
		/^jiff(?:_|$)/.test(crate ?? "") ||
		symbol === "_mal_host_install_intrinsic_date" ||
		(bytes === 206788 && object.startsWith("libmal_rust.a(")),
	"relocated primordial bindings": ({ symbol, relocatedConstant }) =>
		relocatedConstant && /^_mal_vm_load_primordial\.bindings(?:$|\.)/.test(symbol),
	rustls: ({ crate }) => /^rustls(?:_|$)/.test(crate ?? ""),
	"sqlite3.o": ({ object }) => /(?:^|[(-])sqlite3\.o\)?$/.test(object),
	node_fs: ({ object }) => /(?:^|[(-])node_fs\.o\)?$/.test(object),
	"Node streams": ({ object }) => /(?:^|[(-])node_stream\.o\)?$/.test(object),
	"Full Node process support": ({ object }) =>
		/(?:^|[(-])node_(?:process|events|async_hooks|inspect)\.o\)?$/.test(object),
	"Array.fromAsync": ({ symbol }) =>
		/^_mal_builtin_array_from_async(?:$|\.)/.test(symbol),
	"URL.canParse": ({ symbol }) => /^_url_can_parse(?:$|\.)/.test(symbol),
	"Fetch objects": ({ object }) => /(?:^|[(-])web_fetch\.o\)?$/.test(object),
	"HTTP client": ({ object, symbol }) =>
		/(?:^|[(-])(?:web_fetch_client|http_client)\.o\)?$/.test(object) ||
		/^_mal_(?:web_fetch_client|http_client)_/.test(symbol),
	TLS: ({ crate, object, symbol }) =>
		/^rustls(?:_|$)/.test(crate ?? "") ||
		/(?:^|[(-])node_tls\.o\)?$/.test(object) ||
		symbol.startsWith("_mal_tls_"),
	ring: ({ symbol }) => symbol.startsWith("_ring_core_"),
	Ada: ({ object }) => /(?:^|[(-])ada\.o\)?$/.test(object),
	regress: ({ crate, symbol }) =>
		crate === "regress" || /^_mal_regexp_(?:compile|release)(?:$|\.)/.test(symbol),
	"RegExp builtins": ({ object }) => /(?:^|[(-])builtin_regexp\.o\)?$/.test(object),
	"Proxy traps": ({ object }) => /(?:^|[(-])proxy_object\.o\)?$/.test(object),
	"BigInt arithmetic": ({ object }) =>
		/(?:^|[(-])(?:heap|builtin)_bigint\.o\)?$/.test(object),
	"unicode.o": ({ object, symbol }) =>
		/(?:^|[(-])unicode\.o\)?$/.test(object) ||
		/^_mal_unicode_(?:decomposition|composition)(?:$|\.)/.test(symbol),
	// Every runtime archive carries the Node modules; only Node programs may link them.
	"Node runtime": ({ object, symbol }) =>
		/(?:^|[(-])node_[a-z0-9_]+\.o\)?$/.test(object) ||
		/^_mal_node_/.test(symbol) ||
		// The Error intrinsics compare against the hooks marker, which every program links.
		/^_mal_host_install_node_(?!error_hooks$)/.test(symbol),
	argon2: ({ crate, symbol }) =>
		crate === "argon2" || symbol.startsWith("_mal_argon2_abi"),
} satisfies Record<string, (entry: LinkedSymbol) => boolean>;

type ForbiddenComponent = keyof typeof forbiddenComponents;

const forbiddenLibraries = {
	"C++ runtime": /(?:^|\/)lib(?:c\+\+(?:abi)?|stdc\+\+)\./,
} satisfies Record<string, RegExp>;

type ForbiddenLibrary = keyof typeof forbiddenLibraries;

function dynamicLibraries(binaryPath: string, env: NodeJS.ProcessEnv): Array<string> {
	if (process.platform === "darwin") {
		return execFileSync("otool", ["-L", binaryPath], { encoding: "utf8", env })
			.split("\n")
			.slice(1)
			.flatMap((line) => /^\s*(\S+)\s+\(/.exec(line)?.[1] ?? []);
	}
	return execFileSync("readelf", ["-d", binaryPath], { encoding: "utf8", env })
		.split("\n")
		.flatMap((line) => /\(NEEDED\).*\[(.+)\]/.exec(line)?.[1] ?? []);
}

const fixtures: Array<{
	name: string;
	file: string;
	bun: boolean;
	forbidden?: ReadonlyArray<ForbiddenComponent>;
	forbiddenLibraries?: ReadonlyArray<ForbiddenLibrary>;
}> = [
	{
		name: "hello",
		file: "bench/size/hello.mjs",
		bun: true,
		forbidden: [
			"HTTP client",
			"TLS",
			"ring",
			"Ada",
			"regress",
			"RegExp builtins",
			"Proxy traps",
			"BigInt arithmetic",
			"unicode.o",
			"Node runtime",
			"Date timezone data",
			"Array.fromAsync",
			"relocated primordial bindings",
			"sqlite3.o",
		],
		forbiddenLibraries: ["C++ runtime"],
	},
	{
		name: "serve",
		file: "bench/size/serve.mjs",
		bun: false,
		forbidden: ["brotli", "rustls", "Node runtime", "sqlite3.o", "argon2"],
	},
	{
		name: "fetch",
		file: "bench/size/fetch.mjs",
		bun: true,
		forbidden: ["Node runtime", "sqlite3.o", "argon2", "Brotli encoder", "URL.canParse"],
	},
	{
		name: "node-hello",
		file: "bench/size/node-hello.mjs",
		bun: true,
		forbidden: ["Ada", "sqlite3.o", "node_fs", "argon2", "Date timezone data"],
		forbiddenLibraries: ["C++ runtime"],
	},
	{
		name: "process-env",
		file: "bench/size/process-env.mjs",
		bun: true,
		forbidden: ["Full Node process support", "Ada", "TLS", "sqlite3.o"],
		forbiddenLibraries: ["C++ runtime"],
	},
	{
		name: "node-fs",
		file: "bench/size/node-fs.mjs",
		bun: true,
		forbidden: [
			"Ada",
			"brotli",
			"TLS",
			"HTTP client",
			"Node streams",
			"Fetch objects",
			"fs.Stats",
			"Date timezone data",
			"sqlite3.o",
		],
		forbiddenLibraries: ["C++ runtime"],
	},
	{
		name: "http-bare",
		file: "bench/http/server_mal.js",
		bun: false,
		forbidden: ["brotli", "rustls", "Node runtime", "sqlite3.o", "argon2"],
	},
	{
		name: "node-net",
		file: "bench/size/node-net.mjs",
		bun: true,
		forbidden: ["TLS", "sqlite3.o"],
	},
	{
		name: "express",
		file: "bench/http/express-server.cjs",
		bun: true,
		forbidden: ["Brotli encoder", "rustls", "argon2"],
	},
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

function darwinAttribution(
	mapFile: string,
	built: LocalBuildResult,
	forbidden: ReadonlyArray<ForbiddenComponent>,
) {
	const { c, rust } = built.artifacts;
	const archiveNames = new Map([
		[c.runtime, "libMalRuntime.a"],
		[c.host, "libMalHost.a"],
		[c.engine, "libLibMaligator.a"],
		[rust.library, "libmal_rust.a"],
		...rust.nativeComponents.map(
			({ packageName, library }) => [library, `${packageName}.a`] as const,
		),
	]);
	const originals = built.artifacts.linkArgs.filter(
		(argument) => !argument.startsWith("-"),
	);
	const byObject = new Map<string, number>();
	const byRustCrate = new Map<string, number>();
	const retainedForbidden = new Map<ForbiddenComponent, LinkedSymbol>();
	const names = new Map<number, string>();
	const zeroFill: Array<{ address: number; end: number }> = [];
	let text = { address: 0, end: 0 };
	let dataConst = { address: 0, end: 0 };
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
			const range = /^(0x\w+)\s+(0x\w+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
			if (range === null) continue;
			const address = Number(range[1]);
			const extent = { address, end: address + Number(range[2]) };
			if (range[3] === "__TEXT" && range[4] === "__text") text = extent;
			if (range[3] === "__DATA_CONST" && range[4] === "__const") dataConst = extent;
			if (/^__(?:bss|common|thread_bss)$/.test(range[4]!)) zeroFill.push(extent);
		}
		if (section === "# Symbols:") {
			const entry = /^(0x\w+)\s+(0x\w+)\s+\[\s*(\d+)\]\s+(.+)$/.exec(line);
			if (entry === null) continue;
			const symbol = entry[4]!;
			const object = names.get(Number(entry[3]));
			if (object === undefined)
				throw new Error(`Unknown object for map symbol ${symbol}`);
			const crate = rustCrate(symbol);
			const address = Number(entry[1]);
			const bytes = Number(entry[2]);
			const linked = {
				object,
				symbol,
				crate,
				instruction: text.address <= address && address < text.end,
				relocatedConstant: dataConst.address <= address && address < dataConst.end,
				bytes,
			};
			for (const component of forbidden) {
				if (!retainedForbidden.has(component) && forbiddenComponents[component](linked))
					retainedForbidden.set(component, linked);
			}
			if (
				bytes === 0 ||
				zeroFill.some((range) => range.address <= address && address < range.end)
			)
				continue;
			addBytes(byObject, object, bytes);
			if (crate !== undefined) addBytes(byRustCrate, crate, bytes);
		}
	}
	if (byObject.size === 0) throw new Error(`No linked symbols found in ${mapFile}`);
	return {
		mapFile: path.basename(mapFile),
		byObject: rankedBytes(byObject),
		byRustCrate: rankedBytes(byRustCrate),
		retainedForbidden: [...retainedForbidden].map(([component, entry]) => ({
			component,
			...entry,
		})),
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
	console.log(
		JSON.stringify(
			{
				mode: "production",
				fixtures: fixtures.map((fixture) => ({ ...fixture, config })),
			},
			null,
			2,
		),
	);
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
		const { name, file } = fixture;
		console.log(`Building ${name}`);
		const mapFile = path.join(reportDirectory, `${name}.map`);
		const collectMap = process.platform === "darwin";
		const built = buildNativeBinaryResult({
			fixture: file,
			name,
			config,
			production: true,
			toolchainBridge: false,
			outDir: scratch,
			environment: env,
			nativeLinkCacheVariant: collectMap ? randomUUID() : undefined,
			measureNativeBuildResources: collectMap,
			onNativeCommandResource: collectMap
				? (event) => replayWithMap(event, scratch, mapFile, env)
				: undefined,
		});
		const binaryBytes = statSync(built.binaryPath).size;
		const libraries = dynamicLibraries(built.binaryPath, env);
		const { linkAllRustComponents, sectionGcLinkArgs } = built.context.toolchain.probes;
		const selectiveLink = !linkAllRustComponents && sectionGcLinkArgs.length > 0;
		const { rust } = built.artifacts;
		if (
			selectiveLink &&
			fixture.forbidden?.includes("Ada") &&
			rust.nativeComponents.some(
				({ packageName, library }) =>
					packageName === "ada-url" && rust.linkArgs.includes(library),
			)
		) {
			console.error(`  ${name} links the Ada archive`);
			process.exitCode = 1;
		}
		for (const library of fixture.forbiddenLibraries ?? []) {
			if (!selectiveLink && built.context.features.usesHost) continue;
			const loaded = libraries.find((candidate) =>
				forbiddenLibraries[library].test(candidate),
			);
			if (loaded !== undefined) {
				console.error(`  ${name} loads forbidden library ${library} (${loaded})`);
				process.exitCode = 1;
			}
		}
		const attribution = collectMap
			? darwinAttribution(mapFile, built, fixture.forbidden ?? [])
			: undefined;
		let bunBytes: number | undefined;
		if (fixture.bun && bunVersion !== undefined) {
			const outfile = path.join(scratch, `${name}-bun`);
			execFileSync(
				"bun",
				["build", "--compile", path.resolve(file), "--outfile", outfile],
				{
					cwd: scratch,
					env,
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
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
			libraries,
			rustArchive: built.artifacts.rust.cacheKey,
			attribution,
			plan: built.context.plan,
			toolchain: { cc: tools.cc, rustc: tools.rustc, platform, rustTarget },
		});
		console.log(
			`  Maligator ${binaryBytes} bytes${bunBytes === undefined ? "" : `, Bun ${bunBytes} bytes`}`,
		);
		if (attribution !== undefined) {
			console.log(`  Link map ${mapFile}`);
			for (const { component, object } of attribution.retainedForbidden) {
				console.error(`  ${name} retains forbidden component ${component} in ${object}`);
				process.exitCode = 1;
			}
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
