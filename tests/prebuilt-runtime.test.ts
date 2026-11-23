import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactDigest } from "../src/artifact-store.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "../src/build-config.ts";
import {
	localDevelopmentRunnerKey,
	packagedDevelopmentRunner,
	sharedDevelopmentRunnerKey,
} from "../src/local-build.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import {
	DEVELOPMENT_RUNNER,
	embeddedDevelopmentRunnerSourceDigests,
	PREBUILT_RUNTIME_MANIFEST,
	PREBUILT_RUNTIME_OVERRIDE,
	prebuiltDevelopmentRunnerTarget,
	prebuiltRuntimeCxxLibraries,
	prebuiltRuntimeTarget,
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
	options: {
		eval?: boolean;
		production?: boolean;
		realms?: boolean;
		target?: string;
	} = {},
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
	const { rustTarget, platform } = prebuiltRuntimeTarget(options.target ?? macTarget);
	const toolchain: Toolchain = {
		target: rustTarget,
		rustTarget,
		platform,
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
				engine: { eval: options.eval, realms: options.realms },
			}),
		).features,
		toolchain,
		environment: {
			PATH: toolsDirectory,
			MALIGATOR_CACHE_DIR: path.join(directory, "cache"),
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
	runner?: { key: string; evalComponent: boolean },
) {
	const directory = path.join(root, "package");
	mkdirSync(directory);
	const name = DEVELOPMENT_RUNNER;
	const bytes = "#!/bin/sh\nprintf 'ready\\n'\n";
	if (runner !== undefined)
		writeFileSync(path.join(directory, name), bytes, { mode: 0o755 });
	const cxxArchives = prebuiltRuntimeCxxLibraries(identity.target).flatMap(
		({ archive, license }) =>
			archive === undefined ? [] : [`native.ada-url.${license}.a`],
	);
	const manifest: PrebuiltRuntimeManifest = {
		...identity,
		...(runner === undefined
			? {}
			: {
					runner: {
						name,
						...runner,
						sha256: artifactDigest(bytes),
						size: Buffer.byteLength(bytes),
					},
				}),
		files: [...archiveNames, ...cxxArchives].map((name) => {
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

	it.each([
		{ mode: "production", production: true, realms: false },
		{ mode: "development with realms", production: false, realms: true },
	])("uses packaged Rust independently of the C archives in $mode", (options) => {
		const directory = stageRelease(
			runtimeReleaseArchiveIdentity(fixtureContext("producer")),
		);
		rmSync(path.join(directory, "libMalRuntime.a"));
		const context = fixtureContext("consumer", options);
		writeFileSync(
			path.join(context.runtimeDirectory, "src/runtime.c"),
			"int other(void);\n",
		);
		const artifacts = ensureRustArtifacts(context);
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

describe("local development runner keys", () => {
	it("keeps eval-on and eval-off projects in separate runners", () => {
		const disabled = fixtureContext("consumer", { eval: false });
		const enabled = fixtureContext("consumer", { eval: true });
		expect(localDevelopmentRunnerKey(disabled)).not.toBe(
			localDevelopmentRunnerKey(enabled),
		);
	});
});

const hostTarget = prebuiltDevelopmentRunnerTarget({});

describe.skipIf(hostTarget === undefined)("prebuilt development runners", () => {
	const target = hostTarget!;

	function stageRunner(context: ReturnType<typeof fixtureContext>): string {
		return stageRelease(runtimeReleaseArchiveIdentity(context), {
			key: sharedDevelopmentRunnerKey(context, target),
			evalComponent: context.features.evalEnabled,
		});
	}

	it.each([
		{
			name: "uses a runner with the eval component for an eval-off project",
			evalComponent: true,
			evalEnabled: false,
			selected: true,
		},
		{
			name: "uses a runner without the eval component for an eval-off project",
			evalComponent: false,
			evalEnabled: false,
			selected: true,
		},
		{
			name: "uses a runner with the eval component for an eval-on project",
			evalComponent: true,
			evalEnabled: true,
			selected: true,
		},
		{
			name: "rejects a runner without the eval component for an eval-on project",
			evalComponent: false,
			evalEnabled: true,
			selected: false,
		},
	])("$name", ({ evalComponent, evalEnabled, selected }) => {
		const producer = fixtureContext("producer", { target, eval: evalComponent });
		const consumer = fixtureContext("consumer", { target, eval: evalEnabled });
		const directory = stageRunner(producer);
		expect(
			packagedDevelopmentRunner(consumer, consumer.features, consumer.environment),
		).toBe(selected ? path.join(directory, DEVELOPMENT_RUNNER) : undefined);
	});

	it("selects the same packed runner from embedded source digests", () => {
		const producer = fixtureContext("producer", { target });
		const source = producer.runtimeDirectory;
		mkdirSync(path.join(source, "src", "nested"));
		mkdirSync(path.join(source, "rust", "target"));
		writeFileSync(path.join(source, "src/nested/a.c"), "int a;\n");
		writeFileSync(path.join(source, "src/nested-a.c"), "int b;\n");
		writeFileSync(path.join(source, "rust/target/object.rs"), "pub fn unused() {}\n");
		const directory = stageRunner(producer);
		const files = [
			"dev_main.c",
			"rust/src/lib.rs",
			"rust/target/object.rs",
			"src/nested-a.c",
			"src/nested/a.c",
			"src/runtime.c",
			"src/runtime.h",
		].map((file) => ({
			path: file,
			digest: artifactDigest(readFileSync(path.join(source, file))),
		}));

		expect(
			packagedDevelopmentRunner(
				{
					runtimeDirectory: path.join(root, "unavailable"),
					runnerSourceDigests: () => embeddedDevelopmentRunnerSourceDigests(files),
				},
				producer.features,
				producer.environment,
			),
		).toBe(path.join(directory, DEVELOPMENT_RUNNER));
	});

	it("rejects a runner built from a different driver source", () => {
		const context = fixtureContext("consumer", { target });
		stageRunner(context);
		writeFileSync(
			path.join(context.runtimeDirectory, "dev_main.c"),
			"int main(void) { return 1; }\n",
		);
		expect(
			packagedDevelopmentRunner(context, context.features, context.environment),
		).toBeUndefined();
	});

	it("rejects same-size runner tampering and leaves the archives available for a local link", () => {
		const context = fixtureContext("consumer", { target });
		const directory = stageRunner(context);
		const executable = path.join(directory, DEVELOPMENT_RUNNER);
		writeFileSync(executable, readFileSync(executable, "utf8").replace("ready", "wrong"));
		expect(
			packagedDevelopmentRunner(context, context.features, context.environment),
		).toBeUndefined();
		expect(readFileSync(ensureNativeArtifacts(context).c.runtime, "utf8")).toBe(
			"release fixture libMalRuntime.a",
		);
	});
});
