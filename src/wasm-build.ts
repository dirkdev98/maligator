import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	artifactActionKey,
	artifactDigest,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import { buildDerivationFromConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { createCacheLease } from "./cache-management.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { compileEntrypoint } from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { hashDirectoryTrees } from "./file-tree.ts";
import { requireWasmToolchain } from "./toolchain.ts";
import type { WasmToolchain } from "./toolchain.ts";

export const WASM_ABI_VERSION = 1;
type ArtifactAction = ReturnType<typeof publishArtifactAction>;
export const WASM_EXPORTS = [
	"mal_wasm_abi_version",
	"mal_wasm_init",
	"mal_wasm_call",
	"mal_wasm_output_length",
	"mal_wasm_status",
	"mal_wasm_collection_count",
	"mal_wasm_release",
	"mal_wasm_dispose",
	"malloc",
	"free",
];

export interface WasmBuildOptions {
	root: string;
	entry: string;
	config: ResolvedBuildConfig;
	output: string;
	memoryBytes?: number;
	onProgress?: (message: string) => void;
}

export function assertWasmEngineConfig(config: ResolvedBuildConfig): void {
	if (
		config.engine.eval !== false ||
		config.engine.realms ||
		config.engine.temporal ||
		config.engine.intl.enabled ||
		config.surface.webPlatform ||
		config.surface.node ||
		config.surface.maligator ||
		Object.keys(config.assets).length > 0
	) {
		throw new Error(
			"The Wasm reactor supports the synchronous engine with eval, realms, Intl, Temporal, host surfaces, and assets disabled",
		);
	}
}

export function validateWasmModule(bytes: Uint8Array): void {
	const module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
	const exportNames = new Set(
		WebAssembly.Module.exports(module).map((item) => item.name),
	);
	for (const name of ["memory", ...WASM_EXPORTS]) {
		if (!exportNames.has(name)) throw new Error(`Wasm reactor is missing export ${name}`);
	}
	for (const item of WebAssembly.Module.imports(module)) {
		if (item.module !== "wasi_snapshot_preview1" || item.kind !== "function")
			throw new Error(`Unexpected Wasm import: ${item.module}.${item.name}`);
	}
}

function sourceHash(
	root: string,
	directories: Array<string>,
	files: Array<string>,
): string {
	return hashDirectoryTrees({
		root,
		directories: directories.map((directory) => path.join(root, directory)),
		include: (entry) => /\.(?:ts|mts|c|h|rs)$/.test(entry.name),
		prefix: files.flatMap((file) => [
			file,
			artifactDigest(readFileSync(path.join(root, file))),
		]),
	});
}

/** Build an engine reactor using the same source compiler and artifact store as native builds. */
export function buildWasmEngine(options: WasmBuildOptions) {
	assertWasmEngineConfig(options.config);
	const root = path.resolve(options.root);
	const memoryBytes = options.memoryBytes ?? 256 * 1024 * 1024;
	if (
		!Number.isSafeInteger(memoryBytes) ||
		memoryBytes < 32 * 1024 * 1024 ||
		memoryBytes > 1024 * 1024 * 1024 ||
		memoryBytes % 65536 !== 0
	) {
		throw new Error("Wasm memory must be page-aligned and between 32 MiB and 1 GiB");
	}
	const toolchain = requireWasmToolchain(root);
	const cache = maligatorCacheDirectory();
	const workRoot = path.join(cache, "work/wasm");
	mkdirSync(workRoot, { recursive: true });
	const producer = artifactProducer(
		"wasm",
		1,
		artifactDigest(readFileSync(path.join(root, "src/wasm-build.ts"))),
	);
	const lease = createCacheLease("build-wasm");
	const counts = { built: 0, reused: 0 };
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ZIG_GLOBAL_CACHE_DIR: path.join(cache, "zig/global"),
		ZIG_LOCAL_CACHE_DIR: path.join(cache, "zig/local"),
		RUSTC: toolchain.tools.rustc.path,
	};
	const features = buildDerivationFromConfig(options.config).features;
	const runtime = path.join(root, "runtime");
	const includes = ["src", "src/host", "src/runtime", "rust/include"].flatMap(
		(directory) => ["-I", path.join(runtime, directory)],
	);
	const flags = [
		"cc",
		"-target",
		toolchain.zigTarget,
		"-std=c2x",
		"-O1",
		"-D_GNU_SOURCE",
		"-D_WASI_EMULATED_MMAN",
		"-D_WASI_EMULATED_SIGNAL",
		"-D_WASI_EMULATED_GETPID",
		...features.cDefines,
		...includes,
	];
	const log = options.onProgress ?? (() => {});
	const run = (
		directory: string,
		tool: string,
		args: Array<string>,
		environment = env,
		timeout = 120_000,
	): void => {
		writeFileSync(path.join(directory, "command.json"), JSON.stringify({ tool, args }));
		try {
			const output = execFileSync(tool, args, {
				cwd: root,
				env: environment,
				encoding: "utf8",
				timeout,
				maxBuffer: 8 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			});
			writeFileSync(path.join(directory, "command.log"), output);
		} catch (error) {
			const failure = error as Error & { stderr?: string; stdout?: string };
			writeFileSync(
				path.join(directory, "command.log"),
				`${failure.stdout ?? ""}${failure.stderr ?? ""}\n${failure.message}`,
			);
			throw new Error(`Wasm build failed; see ${path.join(directory, "command.log")}`, {
				cause: error,
			});
		}
	};
	const action = (
		stage: string,
		inputs: unknown,
		build: (directory: string) => Array<{ name: string; file: string }>,
	): ArtifactAction => {
		const key = artifactActionKey(producer, inputs);
		return withArtifactActionLock(cache, stage, producer, key, () => {
			const cached = readArtifactAction(cache, stage, producer, key);
			if (cached !== undefined) {
				counts.reused++;
				return cached;
			}
			const directory = mkdtempSync(path.join(workRoot, `${stage}-`));
			const result = publishArtifactAction(cache, stage, producer, key, build(directory));
			counts.built++;
			return result;
		});
	};
	try {
		const runtimeHash = sourceHash(root, ["runtime/src", "runtime/rust/include"], []);
		const rustHash = sourceHash(
			root,
			["runtime/rust/src"],
			[
				"runtime/rust/Cargo.toml",
				"runtime/rust/Cargo.lock",
				"runtime/rust/rust-toolchain.toml",
			],
		);
		const compilerHash = sourceHash(
			root,
			["src/compiler"],
			[
				"src/build-config-values.ts",
				"src/build-config-error.ts",
				"src/utils.ts",
				"node_modules/meriyah/package.json",
			],
		);
		const compileOptions = {
			buildConfig: options.config,
			stripTypes: stripCompactTypes,
			entryGoal: "module" as const,
			coreInstrumentation: "off" as const,
		};
		const graph = buildModuleGraph(path.resolve(root, options.entry), compileOptions);
		const sourceFiles = [...graph.modules]
			.map(
				([file, module]) =>
					[path.relative(root, file), artifactDigest(module.source)] as const,
			)
			.sort(([left], [right]) => left.localeCompare(right));
		const sourceIdentity = artifactDigest(JSON.stringify(sourceFiles));
		const generated = action(
			"wasm-source",
			{ sourceIdentity, compilerHash, config: options.config },
			(directory) => {
				log("Compiling the engine entry to C");
				const image = compileEntrypoint(path.resolve(root, options.entry), {
					...compileOptions,
					runPhase(phase, execute) {
						log(`Compiler: ${phase}`);
						return execute();
					},
				});
				const units = emitProgramTranslationUnits(
					image,
					{ debugInfo: false },
					1024 * 1024,
				);
				return units.map((source, index) => {
					const name = `unit-${String(index).padStart(4, "0")}.c`;
					const file = path.join(directory, name);
					writeFileSync(file, source);
					return { name, file };
				});
			},
		);
		log(`Compiling ${generated.outputs.length} generated C units and the engine runtime`);
		const compileObject = (file: string, digest: string) =>
			artifactOutput(
				action(
					"wasm-object",
					{ digest, runtimeHash, toolchain: toolchain.fingerprint, flags },
					(directory) => {
						const output = path.join(directory, "object.o");
						run(directory, toolchain.tools.zig.path, [
							...flags,
							"-x",
							"c",
							"-c",
							file,
							"-o",
							output,
						]);
						return [{ name: "object.o", file: output }];
					},
				),
				"object.o",
			);
		const objects = generated.outputs.map((output, index) => {
			const object = compileObject(output.path, output.digest);
			if ((index + 1) % 10 === 0)
				log(`Generated C: ${index + 1}/${generated.outputs.length}`);
			return object;
		});
		const runtimeObjects = readdirSync(path.join(runtime, "src"))
			.filter((name) => name.endsWith(".c"))
			.sort()
			.map((name, index) => {
				const file = path.join(runtime, "src", name);
				const object = compileObject(file, artifactDigest(readFileSync(file)));
				if ((index + 1) % 20 === 0) log(`Engine C: ${index + 1} units`);
				return object;
			});
		const engine = artifactOutput(
			action(
				"wasm-archive",
				{
					objects: runtimeObjects.map((object) => object.digest),
					toolchain: toolchain.fingerprint,
				},
				(directory) => {
					const output = path.join(directory, "engine.a");
					run(directory, toolchain.tools.zig.path, [
						"ar",
						"rcs",
						output,
						...runtimeObjects.map((object) => object.path),
					]);
					return [{ name: "engine.a", file: output }];
				},
			),
			"engine.a",
		);
		const rust = artifactOutput(
			action(
				"wasm-rust",
				{ rustHash, features: features.cargoFeatures, toolchain: toolchain.fingerprint },
				(directory) => {
					log("Building the Rust engine library for wasm32-wasip1");
					const target = path.join(directory, "target");
					const rustEnv: NodeJS.ProcessEnv = {
						...env,
						CARGO_TARGET_DIR: target,
						CARGO_BUILD_JOBS: "2",
						RUSTFLAGS: "",
						CARGO_ENCODED_RUSTFLAGS: "",
					};
					for (const key of Object.keys(rustEnv)) {
						if (
							key.startsWith("CARGO_PROFILE_") ||
							key.startsWith("CARGO_TARGET_WASM32_")
						)
							delete rustEnv[key];
					}
					run(
						directory,
						toolchain.tools.cargo.path,
						[
							"build",
							"--manifest-path",
							path.join(runtime, "rust/Cargo.toml"),
							"--target",
							toolchain.target,
							"--release",
							"--locked",
							"--no-default-features",
							...(features.cargoFeatures.length === 0
								? []
								: ["--features", features.cargoFeatures.join(",")]),
						],
						rustEnv,
						300_000,
					);
					return [
						{
							name: "rust.a",
							file: path.join(target, toolchain.target, "release/libmal_rust.a"),
						},
					];
				},
			),
			"rust.a",
		);
		const bridgePath = path.join(runtime, "embedding/wasm.c");
		const bridge = compileObject(bridgePath, artifactDigest(readFileSync(bridgePath)));
		const linked = action(
			"wasm-link",
			{
				objects: objects.map((object) => object.digest),
				engine: engine.digest,
				rust: rust.digest,
				bridge: bridge.digest,
				memoryBytes,
				toolchain: toolchain.fingerprint,
				flags,
			},
			(directory) => {
				log("Linking and validating the Wasm reactor");
				const output = path.join(directory, "engine.wasm");
				// Zig classifies link inputs by extension; cache blobs have digest-only names.
				const linkInputs = [bridge, ...objects, engine, rust].map((artifact, index) => {
					const file = path.join(directory, `${index}-${artifact.name}`);
					copyFileSync(artifact.path, file);
					return file;
				});
				run(directory, toolchain.tools.zig.path, [
					...flags,
					"-mexec-model=reactor",
					"-Wl,-z,stack-size=16777216",
					`-Wl,--max-memory=${memoryBytes}`,
					"-Wl,--strip-all",
					...WASM_EXPORTS.map((name) => `-Wl,--export=${name}`),
					...linkInputs,
					"-lwasi-emulated-mman",
					"-lwasi-emulated-signal",
					"-lwasi-emulated-getpid",
					"-o",
					output,
				]);
				validateWasmModule(readFileSync(output));
				return [{ name: "engine.wasm", file: output }];
			},
		);
		const module = artifactOutput(linked, "engine.wasm");
		const manifest = {
			schema: 1,
			abi: WASM_ABI_VERSION,
			sourceIdentity,
			compilerHash,
			runtimeHash,
			rustHash,
			toolchain,
			config: options.config,
			memoryBytes,
			digest: module.digest,
			bytes: module.size,
		};
		mkdirSync(path.dirname(options.output), { recursive: true });
		copyFileSync(module.path, options.output);
		writeFileSync(`${options.output}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
		log(
			`Wasm ready: ${module.size} bytes; ${counts.reused} cached actions, ${counts.built} built`,
		);
		return { ...manifest, counts, file: options.output };
	} finally {
		lease.release();
	}
}

export function probeWasmToolchain(root: string, toolchain: WasmToolchain): void {
	const directory = mkdtempSync(path.join(root, ".cache/wasm-doctor-"));
	const source = path.join(directory, "probe.c");
	const output = path.join(directory, "probe.wasm");
	writeFileSync(
		source,
		"#include <stdint.h>\nstatic_assert(sizeof(void *) == 4);\nint probe(void) { return 42; }\n",
	);
	execFileSync(
		toolchain.tools.zig.path,
		[
			"cc",
			"-target",
			toolchain.zigTarget,
			"-std=c2x",
			"-mexec-model=reactor",
			"-Wl,--export=probe",
			source,
			"-o",
			output,
		],
		{
			timeout: 60_000,
			stdio: "pipe",
			env: {
				...process.env,
				ZIG_GLOBAL_CACHE_DIR: path.join(maligatorCacheDirectory(), "zig/global"),
				ZIG_LOCAL_CACHE_DIR: path.join(maligatorCacheDirectory(), "zig/local"),
			},
		},
	);
	const module = new WebAssembly.Module(readFileSync(output));
	const instance = new WebAssembly.Instance(module, {});
	if ((instance.exports.probe as () => number)() !== 42)
		throw new Error("Wasm toolchain control failed");
}
