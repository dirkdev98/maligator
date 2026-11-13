import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { prebuiltCompilerBake } from "../../src/test-harness.ts";

let runner: string;
const config = resolveBuildConfig({ surface: { node: true }, engine: { eval: true } });
const directory = mkdtempSync(join(tmpdir(), "mal-development-runner-options-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeAll(() => {
	const derivation = buildDerivationFromConfig(config);
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({
			features: derivation.features,
			compilerBake: prebuiltCompilerBake(),
		}),
		false,
		derivation.cacheSuffix,
	).binaryPath;
});

it.each(["-e", "--eval"])("rejects script evaluation through %s", (option) => {
	const result = spawnSync(runner, [option, 'console.log("fictional eval marker")'], {
		encoding: "utf8",
		timeout: 30_000,
	});
	expect(result.status, result.stderr).toBe(2);
	expect(result.stdout).toBe("");
});

it("loads a prepared image and forwards script arguments", () => {
	const entrypoint = join(directory, "entry.mjs");
	writeFileSync(
		entrypoint,
		"console.log(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }));",
	);
	const image = compileEntrypoint(entrypoint, { buildConfig: config });
	const wire = join(directory, "entry.malw");
	writeFileSync(wire, serializeRuntimeImage(image.runtime));
	const result = spawnSync(runner, [wire, "two words", "--argument"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		argv: [entrypoint, "two words", "--argument"],
		execArgv: [],
	});
});
