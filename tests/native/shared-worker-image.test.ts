import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { workerRootEntries } from "../../src/compiler/pipeline/compile-worker-images.ts";
import { compilerProgramFactsFromConfig } from "../../src/compiler/shared/compiler-facts.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { emitWorkerRegistryTranslationUnit } from "../../src/compiler/target/emit-worker-images.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { HOST_MAIN, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mal-shared-worker-"));
let binary: string;

beforeAll(() => {
	const config = resolveBuildConfig({
		engine: { eval: false, intl: { enabled: false } },
		surface: { node: true, maligator: true },
	});
	const semantic = loadEntrypointAndRunSemanticAnalysis(
		path.resolve("tests/local/shared-worker-image.mjs"),
		{ buildConfig: config, stripTypes: stripCompactTypes },
	);
	const image = compileSemanticProgramToProgramImage(semantic, {
		facts: compilerProgramFactsFromConfig(config),
	});
	const derivation = buildDerivationFromConfig(config);
	binary = buildLocalBinary({
		context: resolveNativeBuildContext({ features: derivation.features }),
		name: "shared-worker-image",
		outDir: directory,
		mainFile: HOST_MAIN,
		cacheSuffix: derivation.cacheSuffix,
		verbose: false,
		cSource: [
			...emitProgramTranslationUnits(image, { compiled: true, maligatorSurface: true }),
			emitWorkerRegistryTranslationUnit(
				workerRootEntries(semantic.graph ?? {}).map((entry) => ({
					entry,
					imageSymbol: "mal_runtime_image",
				})),
			),
		],
	}).binaryPath;
}, 600_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const stress of [false, true]) {
	it(`isolates globals and modules while preserving raw workers, pools, transfers and cancellation (${stress ? "GC stress" : "normal"})`, () => {
		expect(
			runToStdout(binary, { env: stress ? STRESS_ENV : {}, timeoutMs: 30_000 }),
		).toBe("workers PASS\n");
	});
}
