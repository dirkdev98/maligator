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

it.each([false, true])(
	"preserves leaf results and collecting canonical fallbacks with profiling %s",
	(profile) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-reachable-entries-"));
		try {
			const fixture = resolve("tests/local/native-reachability-entries.mjs");
			const source = readFileSync(fixture, "utf8");
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const config = resolveBuildConfig({
				engine: {
					primordials: "locked",
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
			for (const [name, representation] of [
				["narrowNumber", "number"],
				["narrowBoolean", "boolean"],
				["narrowString", "string"],
				["phiNumber", "number"],
				["phiText", "string"],
				["phiCascade", "number"],
				["phiNumberFromString", "number"],
				["phiTextFromNumber", "string"],
				["phiBoolean", "boolean"],
			] as const) {
				const fn = restored.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				expect(
					fn.directEntries.some((entry) => entry.resultRepresentation === representation),
					name,
				).toBe(true);
			}
			const native = restored.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "refined",
			)!;
			const discard = restored.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "discard",
			)!;
			expect(discard.storage!.elidedPureIps).toEqual([]);
			expect(
				discard.directEntries.some((entry) => entry.storage!.elidedPureIps.length > 0),
			).toBe(!profile);
			expect(
				native.directEntries.some(
					(entry) =>
						entry.storage!.controlFlow !== undefined &&
						entry.storage!.numericWorker?.pollingIps.length === 0,
				),
			).toBe(true);
			for (const compiled of [true, false]) {
				const binary = buildNativeProgramImage(restored, {
					name: `reachable-entries-${compiled}`,
					outDir: directory,
					config,
					compiled,
					profileEnabled: profile,
					nativeStackRoots: "precise",
					mainFile: HOST_MAIN,
				});
				for (const env of [{ MAL_HOST_GC: "1" }, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
					expect(runToStdout(binary, { env, timeoutMs: 120000 })).toBe(expected);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
