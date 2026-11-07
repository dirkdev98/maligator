import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../../src/compiler/shared/compiler-facts.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

it.each([true, false])(
	"reads the own length of an array chosen by a condition with compiled=%s",
	(compiled) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-array-length-joins-"));
		try {
			const fixture = resolve("tests/local/array-length-joins.mjs");
			const source = readFileSync(fixture, "utf8");
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			// Exact primordial resolution runs only in a locked single-realm world.
			const config = resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			});
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, fixture),
				{ facts: compilerProgramFactsFromConfig(config) },
			);
			const binary = buildNativeProgramImage(image, {
				name: "array-length-joins",
				outDir: directory,
				config,
				compiled,
				mainFile: HOST_MAIN,
			});
			expect(runToStdout(binary)).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
