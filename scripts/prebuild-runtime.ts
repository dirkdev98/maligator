import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { artifactFileDigest, artifactIdentity } from "../src/artifact-store.ts";
import { writeFileAtomically } from "../src/atomic-file.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "../src/build-config.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import {
	PREBUILT_RUNTIME_CC_FLAGS,
	PREBUILT_RUNTIME_MANIFEST,
	PREBUILT_RUNTIME_OVERRIDE,
	PREBUILT_RUNTIME_ZIG_VERSION,
	prebuiltRuntimeCxxLibraries,
	prebuiltRuntimeTarget,
	readPrebuiltRuntime,
	RELEASE_MACOS_VERSION,
	RUNTIME_ARCHIVES,
	RUST_LIBRARY_OUTPUT,
} from "../src/prebuilt-runtime.ts";
import type { PrebuiltRuntimeManifest } from "../src/prebuilt-runtime.ts";
import {
	ensureNativeArtifacts,
	runtimeReleaseArchiveIdentity,
} from "../src/runtime-build.ts";
import { requireToolchain, toolArguments } from "../src/toolchain.ts";
import type { Toolchain } from "../src/toolchain.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function bundledCxxLibraries(
	toolchain: Toolchain,
	environment: NodeJS.ProcessEnv,
	cwd: string,
): Array<{ name: string; file: string }> {
	const zig = toolchain.tools.zig!;
	const cxx = toolchain.tools.cxx!;
	const cache = environment.ZIG_GLOBAL_CACHE_DIR!;
	const input = path.join(cwd, "cxx.cc");
	writeFileSync(input, "int main() { return 0; }\n");
	const result = spawnSync(
		cxx.path,
		toolArguments(cxx, ["-v", input, "-o", path.join(cwd, "cxx-probe")]),
		{ cwd, env: environment, encoding: "utf8" },
	);
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`Zig C++ link failed\n${result.stderr}`);
	const libraries = result.stderr
		.split(`${cache}${path.sep}`)
		.flatMap((entry) => /^o\/[0-9a-f]+\/([^\s"]+\.a)\b/.exec(entry)?.[0] ?? []);
	const zigEnv = execFileSync(zig.path, ["env"], {
		cwd,
		env: environment,
		encoding: "utf8",
	});
	const libDirectory = /^\s*\.lib_dir = ("(?:[^"\\]|\\.)*"),$/m.exec(zigEnv)?.[1];
	if (libDirectory === undefined)
		throw new Error("Zig did not report its library directory");
	const lib = path.resolve(cwd, JSON.parse(libDirectory) as string);
	return prebuiltRuntimeCxxLibraries(toolchain.rustTarget).flatMap(
		({ archive, license }) => {
			const library = libraries.find((file) => path.basename(file) === archive);
			if (library === undefined) throw new Error(`Zig did not link ${archive}`);
			return [
				{ name: `native.ada-url.${license}.a`, file: path.join(cache, library) },
				{ name: `LICENSE.${license}`, file: path.join(lib, license, "LICENSE.TXT") },
			];
		},
	);
}

/** Use the release target's baseline rather than Zig's host-dependent defaults. */
export function prebuildRuntime(
	triple: string,
	outDirectory: string,
	onProgress?: (message: string) => void,
): PrebuiltRuntimeManifest {
	const target = prebuiltRuntimeTarget(triple);
	const runtimeDirectory = path.join(repositoryRoot, "runtime");
	const rustDirectory = path.join(runtimeDirectory, "rust");
	const rustToolchain = /^channel = "([^"]+)"$/m.exec(
		readFileSync(path.join(rustDirectory, "rust-toolchain.toml"), "utf8"),
	)?.[1];
	if (rustToolchain === undefined)
		throw new Error("runtime Rust toolchain pin is missing");
	const { features } = buildDerivationFromConfig(resolveBuildConfig({}));
	const {
		PATH,
		HOME,
		TMPDIR,
		CARGO_HOME,
		RUSTUP_HOME,
		ZIG,
		MAL_BUILD_JOBS,
		CARGO_BUILD_JOBS,
		MALIGATOR_WORKERS,
		ZIG_GLOBAL_CACHE_DIR,
		ZIG_LOCAL_CACHE_DIR,
	} = process.env;
	const environment = {
		PATH,
		HOME,
		TMPDIR,
		CARGO_HOME,
		RUSTUP_HOME,
		RUSTUP_TOOLCHAIN: rustToolchain,
		ZIG,
		MAL_BUILD_JOBS,
		CARGO_BUILD_JOBS,
		MALIGATOR_WORKERS,
		ZIG_GLOBAL_CACHE_DIR: ZIG_GLOBAL_CACHE_DIR && path.resolve(ZIG_GLOBAL_CACHE_DIR),
		ZIG_LOCAL_CACHE_DIR: ZIG_LOCAL_CACHE_DIR && path.resolve(ZIG_LOCAL_CACHE_DIR),
		[PREBUILT_RUNTIME_OVERRIDE]: "",
		...(target.platform === "darwin"
			? { MACOSX_DEPLOYMENT_TARGET: RELEASE_MACOS_VERSION }
			: {}),
	};
	const base = requireToolchain({
		target: triple,
		env: environment,
		rustDir: rustDirectory,
	});
	if (base.tools.zig?.version !== PREBUILT_RUNTIME_ZIG_VERSION) {
		throw new Error(
			`runtime archives require Zig ${PREBUILT_RUNTIME_ZIG_VERSION}; set ZIG to its executable`,
		);
	}
	const cc = [
		"cc",
		"-target",
		target.zigTarget,
		target.zigCpu,
		...PREBUILT_RUNTIME_CC_FLAGS,
	];
	const cxx = ["c++", ...cc.slice(1)];
	// Zig passes .i files straight to Clang, which rejects Zig-specific targets.
	const object = [
		"clang",
		"-target",
		target.clangTarget,
		target.clangCpu,
		...PREBUILT_RUNTIME_CC_FLAGS,
	];
	const toolchain: Toolchain = {
		...base,
		zigTarget: target.zigTarget,
		tools: {
			...base.tools,
			cc: { ...base.tools.cc, args: cc },
			cxx: { ...base.tools.cxx!, args: cxx },
		},
		fingerprint: artifactIdentity({ base: base.fingerprint, cc, cxx, object }),
		ccFingerprint: artifactIdentity({ base: base.ccFingerprint, cc, object }),
	};
	const context = resolveNativeBuildContext({
		runtimeDirectory,
		environment,
		toolchain,
		runtimeObjectCompiler: { ...base.tools.cc, args: object },
		features,
		onBuildPhase: ({ phase, cache, durationMs }) => {
			if (phase === "runtime" || phase === "rust")
				onProgress?.(`${phase} cache ${cache} (${(durationMs / 1000).toFixed(2)}s)`);
		},
	});
	const output = path.resolve(outDirectory);
	mkdirSync(output, { recursive: true });
	const work = mkdtempSync(path.join(output, ".prebuild-"));
	try {
		const identity = runtimeReleaseArchiveIdentity(context);
		const archives = ensureNativeArtifacts(context);
		const files = [
			...Object.entries(RUNTIME_ARCHIVES).map(([layer, name]) => ({
				name,
				file: archives.c[layer as keyof typeof RUNTIME_ARCHIVES],
			})),
			{ name: RUST_LIBRARY_OUTPUT, file: archives.rust.library },
			...archives.rust.nativeComponents
				.map(({ name, library }) => ({ name, file: library }))
				.sort((left, right) =>
					left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
				),
			...bundledCxxLibraries(toolchain, context.environment, work),
		];
		if (runtimeReleaseArchiveIdentity(context).key !== identity.key)
			throw new Error("runtime sources changed during archive preparation");
		const manifest: PrebuiltRuntimeManifest = {
			...identity,
			files: files
				.filter(({ name }) => name.endsWith(".a"))
				.map(({ name, file }) => ({
					name,
					sha256: artifactFileDigest(file),
					size: statSync(file).size,
				})),
		};
		for (const { name, file } of files) copyFileSync(file, path.join(output, name));
		writeFileAtomically(
			path.join(output, PREBUILT_RUNTIME_MANIFEST),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		if (readPrebuiltRuntime(output, triple, manifest.key) === undefined)
			throw new Error(`incomplete prebuilt runtime set in ${output}`);
		onProgress?.(`runtime archives ready at ${output}`);
		return manifest;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [targetFlag, target, outFlag, out, ...rest] = process.argv.slice(2);
	if (
		targetFlag !== "--target" ||
		!target ||
		rest.length > 0 ||
		(outFlag !== undefined && (outFlag !== "--out" || !out))
	)
		throw new Error(
			"usage: npm run release:prebuild-runtime -- --target <rust-triple> [--out <directory>]",
		);
	prebuildRuntime(
		target,
		out ??
			path.join(
				repositoryRoot,
				".cache",
				"prebuilt-runtime",
				prebuiltRuntimeTarget(target).rustTarget,
			),
		(message) => process.stdout.write(`${message}\n`),
	);
}
