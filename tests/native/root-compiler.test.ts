import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../../src/compiler/frontend/module-graph.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import {
	compileWorkerImages,
	developmentWorkerManifest,
} from "../../src/compiler/pipeline/compile-worker-images.ts";
import type { CompilerDiagnostic } from "../../src/compiler/shared/compiler-diagnostics.ts";
import { serializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { nativeSourcePath } from "../../src/native-source-path.ts";
import {
	captureRootInputs,
	startNodeRootCompilation,
} from "../../src/node-root-compiler.ts";
import { scaledNativeRunTimeoutMs } from "../../src/test-harness.ts";

const fixtures = path.resolve("tests/fixtures/root-compiler");
const compilerConfig = resolveBuildConfig({
	engine: { eval: false, regexp: false },
	surface: { node: false, webPlatform: false },
});
const hostConfig = resolveBuildConfig({
	engine: {
		eval: false,
		regexp: true,
		realms: false,
		temporal: false,
		intl: { enabled: false },
	},
	surface: { node: true, webPlatform: true, maligator: true },
});

// Both large worker roots and the owner wire hold the whole compiler. Building the graph
// here keeps its ASTs unreachable while the roots compile on helper threads and the owner
// compiles on this one, so the test takes about as long as the largest of the three.
function startFixtureRoots(entrypoint: string) {
	const graph = buildModuleGraph(entrypoint, {
		buildConfig: hostConfig,
		stripTypes: stripCompactTypes,
	});
	return startNodeRootCompilation(
		graph,
		{ buildConfig: hostConfig, stripTypes: stripCompactTypes },
		captureRootInputs(graph),
		{ concurrency: 2 },
	);
}

it(
	"shares the native root kernel, transfers 35 MiB and joins every outcome",
	async () => {
		const evidenceRoot = path.resolve(".cache/root-compiler-failures");
		mkdirSync(evidenceRoot, { recursive: true });
		const directory = mkdtempSync(path.join(evidenceRoot, "run-"));
		let failed = true;
		try {
			const phaseFor =
				(product: string) =>
				<T>(phase: string, run: () => T): T => {
					writeFileSync(
						path.join(directory, "phase.json"),
						JSON.stringify({ product, phase, memory: process.memoryUsage() }),
					);
					return run();
				};
			const entry = path.join(directory, "application.mts");
			writeFileSync(
				entry,
				'import {createWorkerUrl} from "maligator:workers"; export const first=createWorkerUrl("./first.mts", import.meta.url); export const second=createWorkerUrl("./second.mts", import.meta.url);',
			);
			writeFileSync(path.join(directory, "first.mts"), 'export const result = "first";');
			writeFileSync(
				path.join(directory, "second.mts"),
				'export const result = "second";',
			);
			const graph = buildModuleGraph(entry, {
				buildConfig: compilerConfig,
				stripTypes: stripCompactTypes,
			});
			const diagnostics: Array<CompilerDiagnostic> = [];
			const expected = compileWorkerImages(graph, {
				buildConfig: compilerConfig,
				stripTypes: stripCompactTypes,
				optimization: "full",
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			});
			const payload = new Uint8Array(35 * 1024 * 1024);
			payload[0] = 17;
			payload[payload.length - 1] = 29;
			const output = JSON.stringify({
				largeDigest: hash("sha256", payload, "hex"),
				roots: expected.map((worker) => ({
					href: worker.entry.href,
					compiler: hash("sha256", serializeCompilerArtifact(worker.image), "hex"),
					wire: hash("sha256", worker.wire, "hex"),
				})),
				diagnostics,
			});
			const fixture = path.join(fixtures, "main.mts");
			const roots = startFixtureRoots(fixture);
			const ownerWire = path.join(directory, "owner.malw");
			const workerManifest = path.join(directory, "workers.json");
			try {
				writeFileSync(
					ownerWire,
					compileEntrypointToBuffer(fixture, {
						buildConfig: hostConfig,
						stripTypes: stripCompactTypes,
						runPhase: phaseFor("owner wire"),
					}),
				);
				const { workers } = await roots.result;
				writeFileSync(
					workerManifest,
					JSON.stringify(
						developmentWorkerManifest(workers, (bytes, digest) => {
							const file = path.join(directory, `${digest}.malw`);
							writeFileSync(file, bytes);
							return file;
						}),
					),
				);
			} finally {
				await roots.close();
			}
			const assets = path.join(directory, "empty.mala");
			writeFileSync(assets, Buffer.from([77, 65, 76, 65, 1, 0, 0, 0, 0, 0, 0, 0]));
			const bootstrap = compileEntrypoint(path.join(fixtures, "bootstrap.mts"), {
				buildConfig: hostConfig,
				stripTypes: stripCompactTypes,
				runPhase: phaseFor("native bootstrap"),
			});
			const derivation = buildDerivationFromConfig(hostConfig);
			const context = resolveNativeBuildContext({
				features: { ...derivation.features, developmentApiEnabled: true },
			});
			const binary = buildLocalBinary({
				context,
				name: "root-compiler-wire-host",
				outDir: directory,
				verbose: false,
				mainFile: path.join(fixtures, "main.c"),
				cSource: emitProgramTranslationUnits(bootstrap, {
					sourcePath: nativeSourcePath,
					compiled: true,
					maligatorSurface: true,
				}),
			}).binaryPath;
			const result = spawnSync(binary, [ownerWire, workerManifest, assets, entry], {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(90_000, process.env),
				killSignal: "SIGKILL",
				env: process.env,
			});
			writeFileSync(
				path.join(directory, "execution.json"),
				JSON.stringify({
					status: result.status,
					signal: result.signal,
					error: result.error?.message,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
			);
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.signal || "no exit status").toBe(0);
			expect(result.stdout).toBe(
				`${output}\nroot transport PASS\nroot compiler joined PASS\n`,
			);
			failed = false;
		} finally {
			if (failed) process.stderr.write(`Root compiler failure retained: ${directory}\n`);
			else rmSync(directory, { recursive: true, force: true });
		}
	},
	scaledNativeRunTimeoutMs(300_000, process.env),
);
