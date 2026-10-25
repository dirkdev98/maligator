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

it.each(["mutable", "locked"] as const)(
	"preserves surviving virtual values, helper entries and collecting fallbacks under %s primordials",
	(primordials) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-surviving-span-"));
		try {
			const fixture = resolve("tests/local/surviving-span-flow.mjs");
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
			const facts = withProgramClosure(
				compilerProgramFactsFromConfig(config),
				programClosureCertificate({ kind: "whole-program", entry: fixture }, [], []),
			);
			const image = lowerNativeStorage(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(readFileSync(fixture, "utf8"), fixture),
					{ facts, coreVerification: "per-pass" },
				),
				"precise",
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const sources = new Set<string>();
			let overwriteSelected = false;
			for (const name of [
				"stableObserver",
				"stableOverwrite",
				"capturedObserver",
				"capturedOverwrite",
			]) {
				const fn = restored.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(restored.runtime.stringConstants[
								restored.runtime.functions[fn.functionIndex]!.nameStringIndex
							] ?? []),
						) === name,
				)!;
				const entry = fn.directEntries.find(
					(entry) => entry.parameterRepresentations[1] === "string",
				);
				if (entry === undefined) continue;
				overwriteSelected ||= name.endsWith("Overwrite");
				for (const plan of entry.storage!.spanContinuations) sources.add(plan.sourceKind);
				expect(entry.storage!.spanContinuations.length).toBeGreaterThan(0);
				expect(entry.storage!.controlFlow!.unreachableIps.length).toBeGreaterThan(0);
			}
			expect(sources).toEqual(new Set(["split", "regexp"]));
			expect(overwriteSelected).toBe(true);
			const collection = restored.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "collectionPath",
			)!;
			const collectionEntry = collection.directEntries.find(
				(entry) => entry.parameterRepresentations[1] === "string",
			)!;
			expect(collectionEntry).toBeDefined();
			expect(
				collection.specializations.some((region) =>
					region.claimedIps.every((ip) =>
						collectionEntry.storage!.controlFlow!.unreachableIps.includes(ip),
					),
				),
			).toBe(true);
			const reuse = restored.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "mapReusePath",
			)!;
			expect(reuse.storage!.mapEntries).toHaveLength(2);
			const reuseEntry = reuse.directEntries.find(
				(entry) => entry.parameterRepresentations[1] === "string",
			)!;
			expect(reuseEntry).toBeDefined();
			expect(reuseEntry.storage!.mapEntries).toEqual([]);
			for (const name of ["preparedWindow", "switchWindow"]) {
				const fn = restored.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				const entry = fn.directEntries.find(
					(e) => e.parameterRepresentations[1] === "string",
				)!;
				expect(entry, name).toBeDefined();
				const unreachable = new Set(entry.storage!.controlFlow!.unreachableIps);
				if (name === "preparedWindow") {
					expect(fn.storage!.arrayInitializations).toHaveLength(1);
					for (const plan of fn.storage!.arrayInitializations)
						for (const ip of plan.claimedIps) expect(unreachable.has(ip)).toBe(true);
				} else {
					expect(fn.literalSwitches).toHaveLength(1);
					const site = fn.literalSwitches![0]!;
					for (const ip of [
						site.instructionIp,
						site.defaultIp,
						...site.cases.map((c) => c.targetIp),
					])
						expect(unreachable.has(ip)).toBe(true);
				}
			}
			for (const compiled of [true, false]) {
				const binary = buildNativeProgramImage(restored, {
					name: `surviving-span-${primordials}-${compiled}`,
					outDir: directory,
					config,
					compiled,
					profileEnabled: false,
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
