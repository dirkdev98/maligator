import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeEntryLookup } from "../src/compiler/target/lower-native-calls.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function input(operation: "map" | "reduce", observesArguments = false, numeric = false) {
	const source = `globalThis.run = function run(values) {
		return values.${operation}(function callback(${operation === "reduce" ? "accumulator, " : ""}value, index, receiver) {
			let offset = index * 3;
			for(let i=0;i<2;i++) offset += index;
			return ${observesArguments ? "arguments.length + " : ""}${numeric ? `${operation === "reduce" ? "accumulator + " : ""}value + offset` : "[value, offset]"};
		}${operation === "reduce" ? ", 0" : ""});
	};`;
	const path = "/builtin-callback-entry.js";
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, path);
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({
				engine: { eval: false, realms: false, primordials: "mutable" },
			}),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return { semantic, options: { facts, coreVerification: "per-pass" as const } };
}

describe("native entries from builtin callback invocation facts", () => {
	it.each(["map", "reduce"] as const)(
		"discovers the %s index ABI without an ordinary seed call",
		(operation) => {
			const { semantic, options } = input(operation);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			const caller = image.native.functions.find(
				(fn) => fn.storage!.callbackTransports.length > 0,
			)!;
			expect(caller).toBeDefined();
			const transport = caller.storage!.callbackTransports[0]!;
			expect(transport.parameters).toEqual(
				operation === "map"
					? ["boxed", "number", "boxed"]
					: ["boxed", "boxed", "number", "boxed"],
			);
			const callback = image.native.functions[transport.functionIndex]!;
			expect(callback.directEntries).toHaveLength(1);
			const parameterRegisters = Array.from(
				{ length: callback.body.parameterCount },
				(_, index) => index,
			);
			for (const register of parameterRegisters)
				expect(callback.registerRepresentations[register]).toBe("boxed");
			expect(callback.specializedOnly).not.toBe(true);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(
				emitCompiledFunction(
					caller,
					caller.functionIndex,
					"",
					false,
					"static",
					new Set(image.native.functions.map((fn) => fn.functionIndex)),
					image.native.semanticProtectors,
					nativeEntryLookup(image.native.functions),
				),
			).not.toBeNull();
		},
	);

	it("retains callbacks with general argument observation on the canonical ABI", () => {
		const { semantic, options } = input("map", true);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		expect(
			image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
	});

	it.each(["map", "reduce"] as const)(
		"nominates guarded %s value operands only when Number operations improve",
		(operation) => {
			const { semantic, options } = input(operation, false, true);
			const compilation = optimizeSemanticProgramToCore(
				semantic,
				options,
				(_phase, run) => run(),
			);
			const entry = compilation.plan.directEntries.find((entry) =>
				entry.callSites.some((site) => site.builtinCallbackNumbers),
			)!;
			expect(entry).toBeDefined();
			expect(entry.parameterRepresentations).toEqual(
				operation === "map" ? ["f64", "f64", "boxed"] : ["f64", "f64", "f64", "boxed"],
			);
			expect(
				entry.operatorInputs!.some((site) =>
					site.masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER),
				),
			).toBe(true);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			const caller = image.native.functions.find(
				(fn) => fn.storage!.callbackTransports.length,
			)!;
			const transport = caller.storage!.callbackTransports[0]!;
			expect(transport.parameters).toEqual(
				operation === "map"
					? ["number", "number", "boxed"]
					: ["number", "number", "number", "boxed"],
			);
			expect(image.native.functions[transport.functionIndex]!.specializedOnly).not.toBe(
				true,
			);
			expect(compilation.plan.statistics.discovery.compilerWork).toBeGreaterThan(0);
		},
	);

	it("declines numeric identity callbacks whose only scalar result is immediately boxed", () => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run = function(values) { return values.map(function(value) { return value; }); };`,
			"/builtin-callback-entry.js",
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		expect(
			image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
	});

	it("requires the nomination marker and keeps receiver fields outside the numeric hypothesis", () => {
		const { semantic, options } = input("map", false, true);
		const compilation = optimizeSemanticProgramToCore(semantic, options, (_phase, run) =>
			run(),
		);
		const entry = compilation.plan.directEntries.find((entry) =>
			entry.callSites.some((site) => site.builtinCallbackNumbers),
		)!;
		const fn = compilation.program.function(entry.function);
		for (const [parameterRepresentations, callSites] of [
			[
				entry.parameterRepresentations,
				entry.callSites.map(({ builtinCallbackNumbers: _numbers, ...site }) => site),
			],
			[entry.parameterRepresentations.map(() => "f64" as const), entry.callSites],
		] as const) {
			const forged = {
				...entry,
				parameterRepresentations,
				callSites,
				...analyzeCoreNativeEntry(
					fn,
					buildCoreControlFlow(compilation.program, entry.function),
					parameterRepresentations,
					undefined,
					callSites,
				),
			};
			expect(() =>
				verifyCoreOptimizationPlan(
					compilation.program,
					{
						...compilation.plan,
						directEntries: compilation.plan.directEntries.map((candidate) =>
							candidate === entry ? forged : candidate,
						),
					},
					compilation.context,
				),
			).toThrow(/builtin callback contract/);
		}
	});

	it("selects each descriptor index when one callback serves both map and reduce", () => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run = function(values) {
			const callback = function(a, b, c) { return [a, b * 3, c * 4]; };
			return [values.map(callback), values.reduce(callback, 0)];
		};`,
			"/builtin-callback-entry.js",
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length === 2,
		)!;
		expect(caller).toBeDefined();
		const transports = caller.storage!.callbackTransports;
		expect(transports[0]!.parameters).toEqual(["boxed", "number", "boxed"]);
		expect(transports[1]!.parameters[2]).toBe("number");
		expect(new Set(transports.map((plan) => plan.entryId)).size).toBe(2);
	});

	it("rejects callback origins changed after the entry proof was minted", () => {
		const { semantic, options } = input("map");
		const compilation = optimizeSemanticProgramToCore(semantic, options, (_phase, run) =>
			run(),
		);
		const entry = compilation.plan.directEntries.find((entry) =>
			entry.callSites.some((site) => site.builtinCallbackOperation !== undefined),
		)!;
		expect(entry).toBeDefined();
		for (const builtinCallbackOperation of ["Array.prototype.reduce", "Math.round"])
			expect(() =>
				verifyCoreOptimizationPlan(
					compilation.program,
					{
						...compilation.plan,
						directEntries: compilation.plan.directEntries.map((candidate) =>
							candidate !== entry
								? candidate
								: {
										...entry,
										callSites: entry.callSites.map((site) => ({
											...site,
											builtinCallbackOperation,
										})),
									},
						),
					},
					compilation.context,
				),
			).toThrow(/representation proof|builtin callback contract/);
	});

	it("independently rejects forged callback descriptors and duplicate origins", () => {
		const { semantic, options } = input("map");
		const compilation = optimizeSemanticProgramToCore(semantic, options, (_phase, run) =>
			run(),
		);
		const entry = compilation.plan.directEntries.find((entry) =>
			entry.callSites.some((site) => site.builtinCallbackOperation !== undefined),
		)!;
		const fn = compilation.program.function(entry.function);
		for (const callSites of [
			entry.callSites.map((site) => ({
				...site,
				builtinCallbackOperation: "Array.prototype.reduce",
			})),
			[...entry.callSites, ...entry.callSites],
		]) {
			const forged = {
				...entry,
				callSites,
				...analyzeCoreNativeEntry(
					fn,
					buildCoreControlFlow(compilation.program, entry.function),
					entry.parameterRepresentations,
					undefined,
					callSites,
				),
			};
			expect(() =>
				verifyCoreOptimizationPlan(
					compilation.program,
					{
						...compilation.plan,
						directEntries: compilation.plan.directEntries.map((candidate) =>
							candidate === entry ? forged : candidate,
						),
					},
					compilation.context,
				),
			).toThrow(/builtin callback contract/);
		}
	});
});
