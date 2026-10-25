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
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([
	{ primordials: "locked", profile: false, compiled: true },
	{ primordials: "mutable", profile: false, compiled: true },
	{ primordials: "locked", profile: true, compiled: true },
	{ primordials: "locked", profile: false, compiled: false },
] as const)(
	"preserves Number predicate effects and fallbacks with $primordials, profile=$profile, compiled=$compiled",
	({ primordials, profile, compiled }) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-number-observations-"));
		try {
			const fixture = resolve("tests/local/number-predicate-observations.mjs");
			const source = readFileSync(fixture, "utf8");
			const expected = execFileSync(
				process.execPath,
				[
					"--expose-gc",
					"--input-type=module",
					"--eval",
					`${primordials === "locked" ? "Object.freeze(Number);" : ""}\n${source}`,
				],
				{ encoding: "utf8" },
			);
			const config = resolveBuildConfig({
				engine: {
					primordials,
					eval: false,
					realms: false,
					temporal: false,
					intl: { enabled: false },
				},
			});
			const image = lowerNativeStorage(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(source, fixture),
					{ facts: compilerProgramFactsFromConfig(config), profile },
				),
				"precise",
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			if (compiled && primordials === "locked") {
				const named = (name: string) =>
					restored.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
							) === name,
					)!;
				for (const name of [
					"entryFinite",
					"entryInteger",
					"entrySafeInteger",
					"entryNaN",
				]) {
					const entry = named(name).directEntries.find(
						(entry) => entry.storage?.controlFlow,
					);
					expect(entry, name).toBeDefined();
					expect(entry!.storage!.rootSlotCount, name).toBe(0);
				}
				const retained = named("entryWithRoots").directEntries.find(
					(entry) => entry.storage?.controlFlow,
				);
				expect(retained).toBeDefined();
				expect(retained!.storage!.rootSlotCount).toBeGreaterThan(0);
			}
			const binary = buildNativeProgramImage(restored, {
				name: "number-predicate-observations",
				outDir: directory,
				config,
				compiled,
				profileEnabled: profile,
				environment: profile ? { ...process.env, MAL_PERF_STATS: "1" } : process.env,
				nativeStackRoots: "precise",
				mainFile: HOST_MAIN,
			});
			for (const env of [{ MAL_HOST_GC: "1" }, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
				expect(runToStdout(binary, { env, timeoutMs: 120000 })).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
