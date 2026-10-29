import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	builtinCallbackInvocation,
	builtinOperationDescriptor,
} from "../src/compiler/shared/builtin-registry.ts";
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

function input(
	operation: "map" | "reduce" | "forEach",
	observesArguments = false,
	numeric = false,
	primordials: "mutable" | "locked" = "mutable",
) {
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
				engine: { eval: false, realms: false, primordials },
			}),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return { semantic, options: { facts, coreVerification: "per-pass" as const } };
}

describe("native entries from builtin callback invocation facts", () => {
	it.each([
		"map",
		"filter",
		"forEach",
		"some",
		"every",
		"find",
		"findIndex",
		"findLast",
		"findLastIndex",
	])(
		"carries the %s family argument roles while observing the rest receiver",
		(method) => {
			const family = builtinOperationDescriptor(
				method === "forEach"
					? "Collection.prototype.forEach"
					: `ArrayOrTypedArray.prototype.${method}`,
			)!;
			expect(family.result).not.toBe("array");
			expect(family.lowerings).toEqual(["generic"]);
			expect(family.guardedCallees).toEqual([
				`Array.prototype.${method}`,
				`TypedArray.prototype.${method}`,
				...(method === "forEach"
					? ["Map.prototype.forEach", "Set.prototype.forEach"]
					: []),
			]);
			for (const callee of family.guardedCallees!)
				expect(builtinCallbackInvocation(callee)).toMatchObject({
					argumentIndex: 0,
					argumentKinds: [
						"any",
						callee.startsWith("Map.") || callee.startsWith("Set.") ? "any" : "number",
						"object",
					],
				});
			for (const primordials of ["mutable", "locked"] as const) {
				const { options } = input("map", false, false, primordials);
				const image = compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`globalThis.run=function(values) {
					return values.${method}(function(value, index, ...tail) {
						for(let i=0;i<2;i++) value += index;
						return value + tail.length + tail[0].length;
					});
				}`,
						"/builtin-callback-entry.js",
					),
					options,
				);
				const owner = image.native.functions.find(
					(fn) => fn.storage!.callbackTransports.length > 0,
				)!;
				expect(owner).toBeDefined();
				const [transport] = owner.storage!.callbackTransports;
				expect(transport!.argumentCount).toBe(3);
				expect(transport!.parameters).toHaveLength(3);
				expect(transport!.parameters.slice(1)).toEqual(["number", "boxed"]);
				expect(transport!.numericReduction).toBeUndefined();
				expect(owner.instructions[transport!.instructionIp]).toMatchObject({
					guardedBuiltinCall: { operation: family.id },
				});
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it("keeps receiver-specific callback semantics separate from invocation families", () => {
		expect(builtinCallbackInvocation("TypedArray.prototype.flatMap")).toBeUndefined();
		expect(
			builtinCallbackInvocation("Collection.prototype.forEach")?.argumentKinds,
		).toEqual(["any", "any", "object"]);
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.run=()=>[1,2].map(function(value,index){for(let i=0;i<2;i++) value+=index;return value;});`,
				"/array-callback.js",
			),
		);
		expect(
			image.native.functions
				.flatMap((fn) => fn.instructions)
				.some(
					(plan) =>
						plan?.kind === "call" &&
						plan.guardedBuiltinCall?.operation === "Array.prototype.map",
				),
		).toBe(true);
	});

	it("preserves guarded Array loop expansion for a nonnumeric reduction callback", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function join(groups) {
			let text = "";
			for (let index = 0; index < groups.length; index++)
				text += groups[index].reduce((acc, value) => acc + value, "");
			return text;
		} globalThis.join = join;`,
			"/array-reduce-inline.js",
		);
		const compilation = optimizeSemanticProgramToCore(
			semantic,
			{ coreVerification: "per-pass" },
			(_phase, run) => run(),
		);
		const invocations = [...compilation.program.functionIds()].flatMap((id) => {
			const fn = compilation.program.function(id);
			return [...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionAttributes(instruction).intrinsic === "__arrayIterationEligible",
			);
		});
		expect(invocations).toHaveLength(1);
	});

	it.each(["reduce", "reduceRight"])(
		"retains concrete builtin identities beneath the %s invocation family",
		(method) => {
			const family = builtinOperationDescriptor(`ArrayOrTypedArray.prototype.${method}`)!;
			expect(family.receiver).toBe("any");
			expect(family.lowerings).toEqual(["generic"]);
			expect(family.guardedCallees).toEqual([
				`Array.prototype.${method}`,
				`TypedArray.prototype.${method}`,
			]);
			const invocation = builtinCallbackInvocation(family.id)!;
			expect(invocation).toEqual({
				kind: "reduction",
				argumentIndex: 0,
				argumentKinds: ["any", "any", "number", "object"],
			});
			for (const callee of family.guardedCallees!)
				expect(builtinCallbackInvocation(callee)).toEqual(invocation);
			expect(builtinCallbackInvocation("Array.prototype.map")).not.toEqual(invocation);
			expect(builtinCallbackInvocation("Math.round")).toBeUndefined();
		},
	);

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

	it.each(["map", "reduce"] as const)(
		"retains the %s invocation count in a typed callback entry",
		(operation) => {
			const { semantic, options } = input(operation, true, true);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			const transport = image.native.functions.flatMap(
				(fn) => fn.storage!.callbackTransports,
			)[0]!;
			expect(transport).toBeDefined();
			expect(transport.argumentCount).toBe(operation === "map" ? 3 : 4);
			expect(transport.numericReduction).toBe(operation === "reduce" ? true : undefined);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it.each([
		[
			"fixed argument snapshots",
			"acc, value",
			"arguments[0] + arguments[1] + arguments[2] + arguments[3].length",
		],
		[
			"rest observations",
			"acc, value, ...tail",
			"acc + value + tail[0] + tail[1].length + tail.length",
		],
		[
			"missing default formal",
			"acc, value, index, receiver, missing = 7",
			"acc + value + index + missing + arguments.length",
		],
	] as const)("carries exact reduce arity through %s", (_name, parameters, result) => {
		for (const primordials of ["mutable", "locked"] as const) {
			const { options } = input("reduce", false, false, primordials);
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`globalThis.run = function(values) {
			return values.reduce(function(${parameters}) {
				for (let i = 0; i < 2; i++) acc += value;
				return ${result};
			}, 0);
		};`,
				"/builtin-callback-entry.js",
			);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			const transport = image.native.functions.flatMap(
				(fn) => fn.storage!.callbackTransports,
			)[0]!;
			expect(transport).toBeDefined();
			expect(transport.argumentCount).toBe(4);
			expect(transport.parameters).toHaveLength(4);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		}
	});

	it.each([
		"return arguments;",
		"globalThis.consume(arguments); return value + index;",
		"return arguments[index];",
		"return arguments[3];",
	])(
		"retains unbounded or unavailable callback arguments on the canonical ABI: %s",
		(body) => {
			const { options } = input("map");
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`globalThis.run = function(values) {
			return values.map(function(value, index) { ${body} });
		};`,
				"/builtin-callback-entry.js",
			);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			expect(
				image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
			).toEqual([]);
		},
	);

	it.each([
		"return tail;",
		"globalThis.consume(tail); return value + index;",
		"tail[0] = value; return value + index;",
	])("retains escaping or changed rest arguments on the canonical ABI: %s", (body) => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run = function(values) {
			return values.map(function(value, index, ...tail) { ${body} });
		};`,
			"/builtin-callback-entry.js",
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		expect(
			image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
	});

	it("does not infer a callback invocation contract from an unknown method", () => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run = function(values) {
			return values.custom(function(value, index) { return value + index + arguments.length; });
		};`,
			"/builtin-callback-entry.js",
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		expect(
			image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
	});

	it("keeps different builtin argument vectors distinct for a callback without formals", () => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run = function(values) {
			const callback = function() { return arguments.length + arguments[0] * 2 + arguments[1] * 3; };
			return [values.map(callback), values.reduce(callback, 0)];
		};`,
			"/builtin-callback-entry.js",
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		const transports = image.native.functions.flatMap(
			(fn) => fn.storage!.callbackTransports,
		);
		expect(transports.map((plan) => plan.argumentCount)).toEqual([3, 4]);
		expect(new Set(transports.map((plan) => plan.entryId)).size).toBe(2);
		for (const transport of transports) {
			const callback = image.native.functions[transport.functionIndex]!;
			expect(callback.body.parameterCount).toBe(0);
			expect(
				callback.directEntries[transport.entryId]!.argumentRepresentations,
			).toHaveLength(transport.argumentCount!);
		}
	});

	it("independently rejects exact arity inconsistent with the builtin body", () => {
		const { semantic, options } = input("reduce", true, true);
		const compilation = optimizeSemanticProgramToCore(semantic, options, (_phase, run) =>
			run(),
		);
		const entry = compilation.plan.directEntries.find(
			(entry) => entry.argumentRepresentations !== undefined,
		)!;
		for (const argumentRepresentations of [
			entry.argumentRepresentations!.slice(0, 3),
			[...entry.argumentRepresentations!, "boxed" as const],
		]) {
			const forged = {
				...entry,
				argumentRepresentations,
				...analyzeCoreNativeEntry(
					compilation.program,
					buildCoreControlFlow(compilation.program, entry.function),
					entry.parameterRepresentations,
					argumentRepresentations,
					entry.callSites,
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

	it.each(["map", "reduce", "forEach"] as const)(
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
				operation !== "reduce" ? ["f64", "f64", "boxed"] : ["f64", "f64", "f64", "boxed"],
			);
			expect(
				entry.instructionFacts!.some((site) =>
					site.masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER),
				),
			).toBe(true);
			const image = compileSemanticProgramToProgramImage(semantic, options);
			const caller = image.native.functions.find(
				(fn) => fn.storage!.callbackTransports.length,
			)!;
			const transport = caller.storage!.callbackTransports[0]!;
			expect(transport.parameters).toEqual(
				operation !== "reduce"
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
	it("retains the guarded numeric index entry when collection values stay boxed", () => {
		const { options } = input("map");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.run=function(values) { values.forEach(function(value,index) { globalThis.observe(value.score + index * 3); }); };`,
			"/collection-index-callback.js",
		);
		const compilation = optimizeSemanticProgramToCore(semantic, options, (_phase, run) =>
			run(),
		);
		const entry = compilation.plan.directEntries.find((entry) =>
			entry.callSites.some(
				(site) => site.builtinCallbackOperation === "Collection.prototype.forEach",
			),
		)!;
		expect(entry.parameterRepresentations).toEqual(["boxed", "f64"]);
		expect(entry.callSites.every((site) => site.builtinCallbackNumbers === true)).toBe(
			true,
		);
		const image = compileSemanticProgramToProgramImage(semantic, options);
		expect(
			image.native.functions
				.flatMap((fn) => fn.storage!.callbackTransports)
				.map((plan) => plan.parameters),
		).toContainEqual(["boxed", "number"]);
	});

	it.each(["map", "forEach"] as const)(
		"requires the %s nomination marker and keeps receiver fields outside the numeric hypothesis",
		(method) => {
			const { semantic, options } = input(method, false, true);
			const compilation = optimizeSemanticProgramToCore(
				semantic,
				options,
				(_phase, run) => run(),
			);
			const entry = compilation.plan.directEntries.find((entry) =>
				entry.callSites.some((site) => site.builtinCallbackNumbers),
			)!;
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
						compilation.program,
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
		},
	);

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
					compilation.program,
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
