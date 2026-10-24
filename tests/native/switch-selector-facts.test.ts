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
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { boxSwitchLocals } from "../helpers/native-switch-facts.ts";

it.each([
	{ primordials: "locked", profile: false },
	{ primordials: "mutable", profile: false },
	{ primordials: "locked", profile: true },
] as const)(
	"executes boxed switch facts with $primordials primordials and profiling $profile",
	({ primordials, profile }) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-switch-facts-"));
		try {
			const fixture = resolve("tests/local/switch-selector-facts.js");
			const config = resolveBuildConfig({
				engine: {
					primordials,
					eval: false,
					realms: false,
					temporal: false,
					intl: { enabled: false },
				},
			});
			const compiled = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(readFileSync(fixture, "utf8"), fixture),
				{ facts: compilerProgramFactsFromConfig(config), profile },
			);
			const boxed = boxSwitchLocals(compiled);
			const image = deserializeCompilerArtifact(serializeCompilerArtifact(boxed));
			const functions = image.native.functions.filter(
				(fn) => (fn.literalSwitches?.length ?? 0) > 0,
			);
			expect(functions.flatMap((fn) => fn.literalSwitches ?? [])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "string" }),
					expect.objectContaining({ kind: "number" }),
				]),
			);
			for (const fn of functions)
				for (const site of fn.literalSwitches ?? [])
					expect(fn.registerRepresentations[site.selector]).toBe("boxed");
			const binary = buildNativeProgramImage(image, {
				name: "switch-facts",
				outDir: directory,
				config,
				environment: profile ? { ...process.env, MAL_PERF_STATS: "1" } : process.env,
				profileEnabled: profile,
				nativeStackRoots: "precise",
				mainFile: HOST_MAIN,
			});
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			for (const env of [{ MAL_HOST_GC: "1" }, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
				expect(runToStdout(binary, { env, timeoutMs: 120000 })).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
