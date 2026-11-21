import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactDigest } from "../src/artifact-store.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "../src/build-config.ts";
import { sharedDevelopmentRunnerKey } from "../src/local-build.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import {
	DEVELOPMENT_RUNNERS,
	PREBUILT_RUNTIME_MANIFEST,
	PREBUILT_RUNTIME_OVERRIDE,
	readPrebuiltDevelopmentRunner,
} from "../src/prebuilt-runtime.ts";
import type { PrebuiltRuntimeManifest } from "../src/prebuilt-runtime.ts";
import {
	ensureNativeArtifacts,
	runtimeReleaseArchiveIdentity,
} from "../src/runtime-build.ts";
import { ensureRustArtifacts } from "../src/rust-build.ts";
import type { Toolchain } from "../src/toolchain.ts";

const macTarget = "aarch64-apple-darwin";
const archiveNames = [
	"libMalRuntime.a",
	"libMalHost.a",
	"libLibMaligator.a",
	"libmal_rust.a",
	"native.ada-url.libada.a",
	"native.ring.libring_core_example.a",
	"native.ada-url.libcxx.a",
	"native.ada-url.libcxxabi.a",
];
const localBuild = new Error("local compiler invoked");
let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "maligator-prebuilt-runtime-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function fixtureContext(
	installation: string,
	options: { production?: boolean; realms?: boolean } = {},
) {
	const directory = path.join(root, installation);
	const runtimeDirectory = path.join(directory, "runtime");
	for (const relative of ["src/host", "src/runtime", "rust/src", "rust/include"])
		mkdirSync(path.join(runtimeDirectory, relative), { recursive: true });
	writeFileSync(path.join(runtimeDirectory, "src/runtime.c"), "int runtime(void);\n");
	writeFileSync(path.join(runtimeDirectory, "src/runtime.h"), "int runtime(void);\n");
	writeFileSync(path.join(runtimeDirectory, "rust/src/lib.rs"), "pub fn demo() {}\n");
	writeFileSync(
		path.join(runtimeDirectory, "dev_main.c"),
		"int main(void) { return 0; }\n",
	);
	const toolsDirectory = path.join(directory, "tools");
	const tool = (name: string) => ({
		path: path.join(toolsDirectory, name),
		version: "1",
	});
	const toolchain: Toolchain = {
		target: "arm64-apple-darwin",
		rustTarget: macTarget,
		platform: "darwin",
		fingerprint: artifactDigest(toolsDirectory),
		ccFingerprint: artifactDigest(tool("cc").path),
		cacheHit: false,
		tools: {
			cc: tool("cc"),
			cxx: tool("c++"),
			ar: tool("ar"),
			rustup: tool("rustup"),
			rustc: tool("rustc"),
			cargo: tool("cargo"),
		},
		probes: {
			c2x: true,
			cxxLink: true,
			cxxLinkArgs: ["-lc++"],
			lto: false,
			ltoFlags: [],
			thinLtoCache: null,
			strip: false,
			stripArgs: [],
			sectionGcLinkArgs: ["-Wl,-dead_strip"],
		},
	};
	return resolveNativeBuildContext({
		runtimeDirectory,
		cacheDirectory: path.join(directory, "cache"),
		features: buildDerivationFromConfig(
			resolveBuildConfig({
				engine: { realms: options.realms },
			}),
		).features,
		toolchain,
		environment: {
			PATH: toolsDirectory,
			[PREBUILT_RUNTIME_OVERRIDE]: path.join(root, "package"),
		},
		production: options.production,
		onCommand: () => {
			throw localBuild;
		},
	});
}

function stageRelease(
	identity: ReturnType<typeof runtimeReleaseArchiveIdentity>,
	runnerKey?: string,
) {
	const directory = path.join(root, "package");
	mkdirSync(directory);
	const name = DEVELOPMENT_RUNNERS.standalone;
	const bytes = "#!/bin/sh\nprintf 'ready\\n'\n";
	if (runnerKey !== undefined)
		writeFileSync(path.join(directory, name), bytes, { mode: 0o755 });
	const manifest: PrebuiltRuntimeManifest = {
		...identity,
		runners:
			runnerKey === undefined
				? {}
				: {
						standalone: {
							name,
							key: runnerKey,
							sha256: artifactDigest(bytes),
							size: Buffer.byteLength(bytes),
						},
					},
		files: archiveNames.map((name) => {
			const bytes = `release fixture ${name}`;
			writeFileSync(path.join(directory, name), bytes);
			return { name, size: Buffer.byteLength(bytes), sha256: artifactDigest(bytes) };
		}),
	};
	writeFileSync(
		path.join(directory, PREBUILT_RUNTIME_MANIFEST),
		JSON.stringify(manifest),
	);
	return directory;
}

describe("prebuilt runtime archives", () => {
	it("imports the same release archives with different tool paths, PATH and source roots", () => {
		const producer = fixtureContext("producer");
		const consumer = fixtureContext("consumer");
		const identity = runtimeReleaseArchiveIdentity(producer);
		expect(runtimeReleaseArchiveIdentity(consumer).key).toBe(identity.key);
		stageRelease(identity);
		const artifacts = ensureNativeArtifacts(consumer);
		expect(readFileSync(artifacts.c.runtime, "utf8")).toBe(
			"release fixture libMalRuntime.a",
		);
		expect(readFileSync(artifacts.rust.library, "utf8")).toBe(
			"release fixture libmal_rust.a",
		);
	});

	it("builds locally when an archive has a same-size content change", () => {
		const context = fixtureContext("consumer");
		const directory = stageRelease(runtimeReleaseArchiveIdentity(context));
		const archive = path.join(directory, "libmal_rust.a");
		writeFileSync(archive, readFileSync(archive, "utf8").replace("release", "changed"));
		expect(() => ensureNativeArtifacts(context)).toThrow(localBuild);
	});

	it("builds locally when the package declares a different target", () => {
		const context = fixtureContext("consumer");
		const identity = runtimeReleaseArchiveIdentity(context);
		stageRelease({ ...identity, target: "x86_64-apple-darwin" });
		expect(() => ensureNativeArtifacts(context)).toThrow(localBuild);
	});

	it("builds locally when the requested flavour enables realms", () => {
		stageRelease(runtimeReleaseArchiveIdentity(fixtureContext("producer")));
		expect(() =>
			ensureNativeArtifacts(fixtureContext("consumer", { realms: true })),
		).toThrow(localBuild);
	});

	it("builds production C locally even after importing development archives without LTO", () => {
		const development = fixtureContext("consumer");
		stageRelease(runtimeReleaseArchiveIdentity(development));
		ensureNativeArtifacts(development);
		expect(() =>
			ensureNativeArtifacts(fixtureContext("consumer", { production: true })),
		).toThrow(localBuild);
	});

	it("uses packaged Rust and its native components when the packaged C archive is missing", () => {
		const directory = stageRelease(
			runtimeReleaseArchiveIdentity(fixtureContext("producer")),
		);
		rmSync(path.join(directory, "libMalRuntime.a"));
		const production = fixtureContext("consumer", { production: true });
		writeFileSync(
			path.join(production.runtimeDirectory, "src/runtime.c"),
			"int other(void);\n",
		);
		const artifacts = ensureRustArtifacts(production);
		expect(readFileSync(artifacts.library, "utf8")).toBe("release fixture libmal_rust.a");
		expect(artifacts.nativeComponents.map(({ packageName }) => packageName)).toEqual(
			expect.arrayContaining(["ada-url", "ring"]),
		);
	});

	it("builds production Rust locally when Rust sources change", () => {
		stageRelease(runtimeReleaseArchiveIdentity(fixtureContext("producer")));
		const production = fixtureContext("consumer", { production: true });
		writeFileSync(
			path.join(production.runtimeDirectory, "rust/src/lib.rs"),
			"pub fn other() {}\n",
		);
		expect(() => ensureRustArtifacts(production)).toThrow(localBuild);
	});
});

describe("prebuilt development runners", () => {
	it("selects the same runner for eval-enabled and eval-disabled images", () => {
		const disabled = fixtureContext("producer");
		const enabled = {
			...disabled,
			features: buildDerivationFromConfig(resolveBuildConfig({ engine: { eval: true } }))
				.features,
		};
		const directory = stageRelease(
			runtimeReleaseArchiveIdentity(disabled),
			sharedDevelopmentRunnerKey(enabled, macTarget),
		);
		expect(
			readPrebuiltDevelopmentRunner(
				directory,
				macTarget,
				"standalone",
				sharedDevelopmentRunnerKey(disabled, macTarget),
			),
		).toBe(path.join(directory, DEVELOPMENT_RUNNERS.standalone));
	});

	it("selects a runner from the same sources under different paths and tools", () => {
		const producer = fixtureContext("producer");
		const consumer = fixtureContext("consumer");
		const directory = stageRelease(
			runtimeReleaseArchiveIdentity(producer),
			sharedDevelopmentRunnerKey(producer, macTarget),
		);
		expect(
			readPrebuiltDevelopmentRunner(
				directory,
				macTarget,
				"standalone",
				sharedDevelopmentRunnerKey(consumer, macTarget),
			),
		).toBe(path.join(directory, DEVELOPMENT_RUNNERS.standalone));
	});

	it("rejects a runner built from a different driver source", () => {
		const context = fixtureContext("consumer");
		const directory = stageRelease(
			runtimeReleaseArchiveIdentity(context),
			sharedDevelopmentRunnerKey(context, macTarget),
		);
		writeFileSync(
			path.join(context.runtimeDirectory, "dev_main.c"),
			"int main(void) { return 1; }\n",
		);
		expect(
			readPrebuiltDevelopmentRunner(
				directory,
				macTarget,
				"standalone",
				sharedDevelopmentRunnerKey(context, macTarget),
			),
		).toBeUndefined();
	});

	it("rejects same-size runner tampering and leaves the archives available for a local link", () => {
		const context = fixtureContext("consumer");
		const key = sharedDevelopmentRunnerKey(context, macTarget);
		const directory = stageRelease(runtimeReleaseArchiveIdentity(context), key);
		const executable = path.join(directory, DEVELOPMENT_RUNNERS.standalone);
		writeFileSync(executable, readFileSync(executable, "utf8").replace("ready", "wrong"));
		expect(
			readPrebuiltDevelopmentRunner(directory, macTarget, "standalone", key),
		).toBeUndefined();
		expect(readFileSync(ensureNativeArtifacts(context).c.runtime, "utf8")).toBe(
			"release fixture libMalRuntime.a",
		);
	});
});
