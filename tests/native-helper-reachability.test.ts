import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeStorage,
	nativeVariantContract,
	validateNativeProgramStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { selectNativeControlFlow } from "../src/compiler/target/native-control-flow.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(primordials: "mutable" | "locked", profile = false) {
	const path = "/helper-flow.mjs";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: false, realms: false, primordials } }),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function inspect(source,flag){if(flag!==flag)source.set(1,'dead');return source.get(2);}
				globalThis.inspect=inspect;
				console.log(inspect(globalThis.input,'string'),inspect(globalThis.input,NaN));`,
				path,
			),
			{ facts, profile, coreVerification: "per-pass" },
		),
		"precise",
	);
}

describe("conditional helper reachability", () => {
	it.each(["mutable", "locked"] as const)(
		"retires only unreachable helper groups under %s primordials",
		(primordials) => {
			for (const profile of [false, true]) {
				const original = compile(primordials, profile);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const fn = image.native.functions[1]!;
					const entry = fn.directEntries.find(
						(e) => e.parameterRepresentations[1] === "string",
					)!;
					const flow = entry.storage!.controlFlow!;
					expect(flow.unreachableIps.length).toBeGreaterThan(0);
					const retired = fn.specializations.filter((region) =>
						region.claimedIps.every((ip) => flow.unreachableIps.includes(ip)),
					);
					expect(retired).toHaveLength(1);
					const retained = fn.specializations.filter(
						(region) => !retired.includes(region),
					);
					expect(retained).toHaveLength(1);
					for (const region of retained)
						for (const ip of [
							...region.claimedIps,
							...region.controlFlow.ordinaryBlockIps,
						])
							expect(flow.unreachableIps).not.toContain(ip);
					expect(fn.storage!.controlFlow).toBeUndefined();
					expect(() =>
						validateNativeProgramStorage(image.native, image.runtime.stringConstants),
					).not.toThrow();
					const emitted = emitCompiledFunction(
						fn,
						fn.functionIndex,
						"",
						false,
						"static",
						new Set(),
						image.native.semanticProtectors,
						new Map(),
						false,
						new Set(),
						image.runtime.stringConstants,
					)!;
					expect(emitted.source).toContain("mal_builtin_map_set_number(");
					expect(emitted.directEntries[entry.id]!.source).not.toContain(
						"mal_builtin_map_set_number(",
					);
					expect(emitted.directEntries[entry.id]!.source).toContain(
						"mal_builtin_map_get_number(",
					);
				}
			}
		},
	);

	it("closes over external and helper-to-helper continuations", () => {
		const image = compile("locked");
		const fn = image.native.functions[1]!;
		const entry = fn.directEntries.find(
			(e) => e.parameterRepresentations[1] === "string",
		)!;
		const flow = entry.storage!.controlFlow!;
		const retired = fn.specializations.find((region) =>
			region.claimedIps.every((ip) => flow.unreachableIps.includes(ip)),
		)!;
		const retained = fn.specializations.find((region) => region !== retired)!;
		const variant = nativeVariantContract(fn, entry);
		const select = (native = variant, externalEntries: ReadonlyArray<number> = []) =>
			selectNativeControlFlow(
				native,
				analyzeNativeBodyFacts(fn.body),
				image.runtime.stringConstants,
				{ constants: entry.constantBooleans, externalEntries },
			)!;
		for (const ip of retired.claimedIps)
			expect(select(variant, [ip]).unreachableIps).toEqual([]);
		const linked = {
			...variant,
			specializations: fn.specializations.map((region) =>
				region !== retained
					? region
					: {
							...region,
							controlFlow: {
								...region.controlFlow,
								ordinaryBlockIps: [
									...region.controlFlow.ordinaryBlockIps,
									retired.license.admission.anchorIp,
								],
							},
						},
			),
		};
		expect(select(linked).unreachableIps).toEqual([]);
	});
});
