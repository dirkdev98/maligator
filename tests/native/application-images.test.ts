import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { nativeSourcePath } from "../../src/native-source-path.ts";
import {
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixtures = path.resolve("tests/fixtures/application-images");
const config = resolveBuildConfig({
	surface: { webPlatform: true, node: true, maligator: true },
	engine: {
		primordials: "locked",
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false },
	},
});
function image(name: string, generation = "first") {
	const entrypoint = path.join(fixtures, `${name}.mjs`);
	return compileEntrypoint(entrypoint, {
		buildConfig: config,
		stripTypes: stripCompactTypes,
		entrySource: readFileSync(entrypoint, "utf8").replace(
			'const generation = "first";',
			`const generation = "${generation}";`,
		),
	});
}
function wire(directory: string, name: string, generation: string) {
	const bytes = serializeRuntimeImage(image(name, generation).runtime);
	const filename = path.join(directory, `${name}-${generation}.malw`);
	writeFileSync(filename, bytes);
	return { path: filename, sha256: hash("sha256", bytes, "hex") };
}
function assetManifest(directory: string, generation: string) {
	const snapshot = path.join(directory, `asset-${generation}.txt`);
	writeFileSync(snapshot, generation);
	const chunks: Array<Buffer> = [Buffer.from("MALA")];
	function u32(value: number) {
		const bytes = Buffer.alloc(4);
		bytes.writeUInt32LE(value);
		chunks.push(bytes);
	}
	function string(value: string) {
		const bytes = Buffer.from(value);
		u32(bytes.length);
		chunks.push(bytes);
	}
	u32(1);
	u32(1);
	string("payload");
	string(hash("sha256", generation));
	string("1");
	chunks.push(Buffer.from([0]));
	u32(1);
	string("payload.txt");
	string(snapshot);
	u32(Buffer.byteLength(generation));
	u32(0);
	const manifest = path.join(directory, `assets-${generation}.mala`);
	writeFileSync(manifest, Buffer.concat(chunks));
	return manifest;
}
function descriptor(directory: string, generation: string) {
	const child = wire(directory, "worker", generation);
	const workerManifestPath = path.join(directory, `workers-${generation}.json`);
	writeFileSync(
		workerManifestPath,
		JSON.stringify({
			schema: 1,
			entries: [
				{
					href: pathToFileURL(path.join(fixtures, "worker.mjs")).href,
					wirePath: child.path,
					sha256: child.sha256,
				},
			],
		}),
	);
	const descriptor = {
		schema: 1,
		wires: [wire(directory, "fragment", generation), wire(directory, "app", generation)],
		workerManifestPath,
		assetManifestPath: assetManifest(directory, generation),
		entryPath: path.join(fixtures, "app.mjs"),
		webPlatform: true,
		node: true,
		engine: {
			primordials: "locked",
			eval: false,
			realms: false,
			regexp: true,
			temporal: false,
			intl: false,
		},
	};
	const filename = path.join(directory, `descriptor-${generation}.json`);
	writeFileSync(filename, JSON.stringify(descriptor));
	return filename;
}
for (const compiled of [true, false]) {
	it(`launches private application generations and joins all retained resources (${compiled ? "native" : "interpreted"})`, () => {
		const failuresRoot = path.resolve(".cache/application-images-failures");
		mkdirSync(failuresRoot, { recursive: true });
		const directory = mkdtempSync(path.join(failuresRoot, "run-"));
		let passed = false;
		try {
			const descriptors = [
				descriptor(directory, "first"),
				descriptor(directory, "second"),
			];
			const unresolved = JSON.parse(readFileSync(descriptors[0]!, "utf8"));
			unresolved.wires = [wire(directory, "unresolved", "third")];
			delete unresolved.workerManifestPath;
			delete unresolved.assetManifestPath;
			const unresolvedPath = path.join(directory, "unresolved.json");
			writeFileSync(unresolvedPath, JSON.stringify(unresolved));
			descriptors.push(unresolvedPath);
			const definition = image("main");
			const derivation = buildDerivationFromConfig(config);
			const context = resolveNativeBuildContext({
				features: { ...derivation.features, developmentApiEnabled: true },
			});
			const binary = buildLocalBinary({
				context,
				name: `application-images-${compiled ? "native" : "interpreted"}`,
				outDir: directory,
				verbose: false,
				mainFile: path.join(fixtures, "main.c"),
				cSource: emitProgramTranslationUnits(definition, {
					sourcePath: nativeSourcePath,
					compiled,
					maligatorSurface: true,
				}),
			}).binaryPath;
			const invocation = resolveHarnessExecutionInvocation(binary);
			const inputs = new Map(
				readdirSync(directory)
					.filter((name) => /\.(json|malw|mala|txt)$/.test(name))
					.map((name) => [name, readFileSync(path.join(directory, name))]),
			);
			const result = spawnSync(
				invocation.executable,
				[...invocation.args, ...descriptors],
				{
					encoding: "utf8",
					killSignal: "SIGKILL",
					env: { ...process.env, ...STRESS_ENV },
					timeout: scaledNativeRunTimeoutMs(10_000, STRESS_ENV),
				},
			);
			if (result.status !== 0) {
				for (const [name, bytes] of inputs)
					writeFileSync(path.join(directory, name), bytes);
				writeFileSync(
					path.join(directory, "failure.json"),
					JSON.stringify(
						{
							status: result.status,
							signal: result.signal,
							error: result.error?.message,
							stdout: result.stdout,
							stderr: result.stderr,
						},
						null,
						2,
					),
				);
			}
			if (result.error !== undefined)
				throw new Error(`${result.error.message}\n${result.stderr}\n${result.stdout}`);
			expect(
				result.status,
				result.stderr || result.stdout || result.signal || "missing exit status",
			).toBe(0);
			expect(result.stdout).toBe("application images PASS\n");
			passed = true;
		} finally {
			if (passed) rmSync(directory, { recursive: true, force: true });
			else console.error(`Application image failure evidence: ${directory}`);
		}
	}, 300_000);
}
