import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../../src/compiler/shared/compiler-facts.ts";
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
	"retains canonical fallbacks and remapped entry ABIs with profiling %s",
	(profile) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-entry-retention-"));
		try {
			const fixture = resolve("tests/local/native-entry-retention.mjs");
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
			const facts = withProgramClosure(
				compilerProgramFactsFromConfig(config),
				programClosureCertificate({ kind: "whole-program", entry: fixture }, [], []),
			);
			const image = lowerNativeStorage(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(readFileSync(fixture, "utf8"), fixture),
					{ facts, profile, coreVerification: "per-pass" },
				),
				"precise",
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const named = (name: string) =>
				restored.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
			const helper = named("stringPath");
			expect(
				helper.directEntries.some((e) =>
					e.parameterRepresentations.every((r) => r === "number"),
				),
			).toBe(false);
			for (const [id, entry] of helper.directEntries.entries()) expect(entry.id).toBe(id);
			const compacted = named("compacted").directEntries.find((e) =>
				e.parameterRepresentations.every((r) => r === "number"),
			)!;
			const calls = compacted.callOverrides!.filter(
				(c) => c.functionIndex === helper.functionIndex,
			);
			expect(calls).toHaveLength(1);
			expect(helper.directEntries[calls[0]!.entryId]!.parameterRepresentations).toEqual([
				"string",
				"number",
			]);
			for (const compiled of [true, false]) {
				const binary = buildNativeProgramImage(restored, {
					name: `entry-retention-${compiled}`,
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
