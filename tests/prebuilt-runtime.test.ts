import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactDigest } from "../src/artifact-store.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "../src/build-config.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import {
	PREBUILT_RUNTIME_MANIFEST,
	PREBUILT_RUNTIME_OVERRIDE,
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

function stageRelease(identity: ReturnType<typeof runtimeReleaseArchiveIdentity>) {
	const directory = path.join(root, "package");
	mkdirSync(directory);
	const manifest: PrebuiltRuntimeManifest = {
		...identity,
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

	it("builds production Rust locally even after importing a development Rust archive", () => {
		const development = fixtureContext("consumer");
		stageRelease(runtimeReleaseArchiveIdentity(development));
		ensureNativeArtifacts(development);
		expect(() =>
			ensureRustArtifacts(fixtureContext("consumer", { production: true })),
		).toThrow(localBuild);
	});
});
