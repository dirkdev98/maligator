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
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([
	{ roots: "precise", compiled: true, primordials: "mutable" },
	{ roots: "conservative", compiled: false, primordials: "locked" },
	{ roots: "precise", compiled: false, primordials: "locked" },
] as const)(
	"restores $roots profiling and counter identities with compiled=$compiled",
	({ roots, compiled, primordials }) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-profile-artifact-"));
		try {
			const fixture = resolve("tests/local/switch-selector-facts.js");
			const source = readFileSync(fixture, "utf8");
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const config = resolveBuildConfig({
				engine: {
					primordials,
					eval: false,
					realms: false,
					temporal: false,
					intl: { enabled: false },
				},
			});
			const original = lowerNativeStorage(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(source, fixture),
					{ profile: true, facts: compilerProgramFactsFromConfig(config) },
				),
				roots,
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(original));
			if (!compiled)
				expect(
					original.runtime.functions.some((fn) =>
						fn.instructions.some(
							(op, ip) =>
								op.opcode === "CALL_KNOWN" &&
								op.operation === "Object.is" &&
								!fn.gcSafepoints?.some((point) => point.instructionIp === ip),
						),
					),
				).toBe(true);
			const captures = [];
			for (const [index, image] of [original, restored].entries()) {
				const binary = buildNativeProgramImage(image, {
					name: `profile-artifact-${index}`,
					outDir: directory,
					config,
					compiled,
					profileEnabled: true,
					environment: { ...process.env, MAL_PERF_STATS: "1" },
					nativeStackRoots: roots,
					mainFile: HOST_MAIN,
				});
				const capture = join(directory, `capture-${index}`);
				expect(
					runToStdout(binary, {
						env: {
							...STRESS_ENV,
							MAL_HOST_GC: "1",
							MAL_PROFILE_CAPTURE: capture,
							MAL_PROFILE_COMPILER: "1",
							MAL_PROFILE_IDENTITY: "a".repeat(64),
						},
						timeoutMs: 120000,
					}),
				).toBe(expected);
				captures.push(parseCompilerCapture(readFileSync(`${capture}.compiler`)));
			}
			expect(captures[1]!.totalSiteCount).toBe(original.profiling!.sites.length);
			expect(captures[1]!.trackedSiteCount).toBe(captures[0]!.trackedSiteCount);
			expect(captures[1]!.bySite.map((site) => site.executions)).toEqual(
				captures[0]!.bySite.map((site) => site.executions),
			);
			expect(captures[1]!.bySite.some((site) => site.executions > 0)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
