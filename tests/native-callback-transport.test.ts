import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import { selectNativeCallbackTransports } from "../src/compiler/target/lower-native-callbacks.ts";
import { nativeEntryLookup } from "../src/compiler/target/lower-native-calls.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";

function callbackImage(body = "return total;", warmArguments = "1, 2") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`
		globalThis.run = () => {
			const transform = function(value, index) {
				let total = value + index;
				for (let i = 0; i < 2; i++) total += value;
				${body}
			};
			transform(${warmArguments});
			return [1, 2, 3].map(transform);
		};`,
			"/native-callback-transport.js",
		),
	);
}

describe("native builtin callback transport", () => {
	it("persists an existing typed entry and emits one shared callback adapter", () => {
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		const [transport] = caller.storage!.callbackTransports;
		expect(transport).toMatchObject({
			parameters: ["number", "number"],
			resultRepresentation: "number",
		});
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(
			restored.native.functions[caller.functionIndex]!.storage!.callbackTransports,
		).toEqual([transport]);
		const output = emitProgramImage(restored, { compiled: true });
		const symbol = `mal_callback_${transport!.functionIndex}_${transport!.entryId}`;
		expect(output).toContain(
			`MAL_BUILTIN_ARRAY_ITERATION_MAP, ${transport!.functionIndex}, ${symbol}`,
		);
		expect(output.match(new RegExp(`MalValue ${symbol}\\([^;]+\\{`, "g"))).toHaveLength(
			1,
		);
		expect(output).toContain("array_iteration_typed_callback_hits");
		expect(output).toContain("array_iteration_typed_callback_fallbacks");
	});

	it("retains the canonical callback when its optional typed entry is unavailable", () => {
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		const transport = caller.storage!.callbackTransports[0]!;
		const emitted = emitCompiledFunction(
			caller,
			caller.functionIndex,
			"",
			false,
			"static",
			new Set([transport.functionIndex]),
		);
		expect(emitted).not.toBeNull();
		expect(emitted!.source).toContain(
			`MAL_BUILTIN_ARRAY_ITERATION_MAP, ${transport.functionIndex}, mal_compiled_${transport.functionIndex}`,
		);
		expect(emitted!.source).not.toContain(`mal_callback_${transport.functionIndex}_`);
	});

	it("drops an oversized typed adapter while retaining its canonical callback", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.run = () => {
					const transform = function(value, index) {
						for (let i = 0; i < 2; i++) globalThis.collect();
						return { value, index };
					};
					transform(1, 2);
					return [1, 2, 3].map(transform);
				};`,
				"/callback-budget.js",
			),
		);
		const transport = image.native.functions.flatMap(
			(fn) => fn.storage!.callbackTransports,
		)[0]!;
		const emit = (maximum: number) =>
			emitProgramTranslationUnits(
				image,
				{ debugInfo: false },
				{
					targetCodeUnits: maximum,
					hardMaximumCodeUnits: maximum,
				},
			);
		const symbol = `mal_callback_${transport.functionIndex}_${transport.entryId}`;
		expect(emit(20_000).some((unit) => unit.source.includes(symbol))).toBe(true);
		const bounded = emit(9_100);
		expect(bounded.every((unit) => unit.source.length <= 9_100)).toBe(true);
		const output = bounded.map((unit) => unit.source).join("\n");
		expect(output).not.toContain(symbol);
		expect(output).not.toContain(
			`mal_direct_${transport.functionIndex}_${transport.entryId}`,
		);
		expect(output).toContain(
			`MAL_BUILTIN_ARRAY_ITERATION_MAP, ${transport.functionIndex}, mal_compiled_${transport.functionIndex}`,
		);
	});

	it("retains the canonical guard fallback even for a specialized-only target", () => {
		const image = callbackImage();
		const transport = image.native.functions.flatMap(
			(fn) => fn.storage!.callbackTransports,
		)[0]!;
		const specialized = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn.functionIndex === transport.functionIndex
						? { ...fn, specializedOnly: true as const }
						: fn,
				),
			},
		};
		for (const output of [
			emitProgramImage(specialized),
			emitProgramTranslationUnits(specialized)
				.map((unit) => unit.source)
				.join("\n"),
		]) {
			expect(output).toMatch(
				new RegExp(`MalValue mal_compiled_${transport.functionIndex}\\([^;]+\\{`),
			);
			expect(output).toContain(`return mal_compiled_${transport.functionIndex}(`);
		}
	});

	it("carries adapter and fallback declarations through split translation units", () => {
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		const transport = caller.storage!.callbackTransports[0]!;
		const units = emitProgramTranslationUnits(image, { compiled: true });
		const callback = `mal_callback_${transport.functionIndex}_${transport.entryId}`;
		const unit = units.find((unit) =>
			unit.source.includes(
				`MAL_BUILTIN_ARRAY_ITERATION_MAP, ${transport.functionIndex}, ${callback}`,
			),
		)!;
		expect(unit).toBeDefined();
		expect(unit.source).toContain(`MalValue ${callback}(`);
		expect(
			units.some((unit) =>
				unit.source.includes(`return mal_compiled_${transport.functionIndex}(`),
			),
		).toBe(true);
	});

	it("rebases callback targets when merging independently compiled images", () => {
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		const merged = mergeProgramImages([image, image]);
		const base = merged.functionBases[1]!;
		const rebased =
			merged.image.native.functions[base + caller.functionIndex]!.storage!
				.callbackTransports[0]!;
		expect(rebased.functionIndex).toBe(
			caller.storage!.callbackTransports[0]!.functionIndex + base,
		);
		expect(() => serializeCompilerArtifact(merged.image)).not.toThrow();
	});

	it("rejects stored callback signatures that diverge from the target ABI", () => {
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		for (const change of [
			{ entryId: 999 },
			{ parameters: ["boxed" as const] },
			{ argumentCount: 4 },
			{ resultRepresentation: "boxed" as const },
		]) {
			expect(() =>
				validateNativeStorage(
					{
						...caller,
						storage: {
							...caller.storage!,
							callbackTransports: caller.storage!.callbackTransports.map((plan) => ({
								...plan,
								...change,
							})),
						},
					},
					nativeEntryLookup(image.native.functions),
				),
			).toThrow(/invalid or stale storage plan/);
		}
	});

	it("requires the callback invocation arity for argument snapshots", () => {
		const mismatched = callbackImage("return total + arguments.length;", "1, 2");
		expect(
			mismatched.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
		const matching = callbackImage("return total + arguments.length;", "1, 2, []");
		expect(
			matching.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([expect.objectContaining({ argumentCount: 3 })]);
	});

	it("does not manufacture callback signatures or consume field-entry arguments", () => {
		const fresh = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.result = [1, 2, 3].some(value => value > 2);`,
				"/fresh-callback.js",
			),
		);
		expect(
			fresh.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toEqual([]);
		const image = callbackImage();
		const caller = image.native.functions.find(
			(fn) => fn.storage!.callbackTransports.length,
		)!;
		const transport = caller.storage!.callbackTransports[0]!;
		const entries = new Map(nativeEntryLookup(image.native.functions));
		const key = `${transport.functionIndex}:${transport.entryId}`;
		entries.set(key, { ...entries.get(key)!, fieldParameters: { keys: [0], loads: [] } });
		expect(selectNativeCallbackTransports(caller, entries)).toEqual([]);
	});
});

describe("resumable callers of selected native entries", () => {
	it.each(["function*", "async function", "async function*"])(
		"uses typed call and callback transports in %s",
		(kind) => {
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`
			function twice(value) { for(let i=0;i<2;i++)value+=1; return value; }
			globalThis.seed=twice(2);
			globalThis.resume=${kind} resume(start,values) {
				const callback=function callback(value,index) { let result=value+index; for(let i=0;i<2;i++)result+=value; return result; };
				callback(1,2);
				const before=twice(+start); ${kind.startsWith("async") ? "await before" : "yield before"};
				const mapped=values.map(callback); return twice(+before)+mapped.length;
			};`,
					"/resumable-transports.js",
				),
			);
			const caller = image.native.functions.find(
				(native) => native.mode === "resumable",
			)!;
			expect(caller.storage!.callTransports.length).toBeGreaterThan(0);
			expect(caller.storage!.callbackTransports).toHaveLength(1);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored.native.functions[caller.functionIndex]!.storage).toEqual(
				caller.storage,
			);
			const callback = caller.storage!.callbackTransports[0]!;
			const emitted = emitCompiledFunction(
				caller,
				caller.functionIndex,
				"",
				false,
				"static",
				new Set([callback.functionIndex]),
				[],
				nativeEntryLookup(image.native.functions),
				false,
				new Set(),
				image.runtime.stringConstants,
			)!;
			expect(emitted.source).toContain(
				`mal_callback_${callback.functionIndex}_${callback.entryId}`,
			);
			for (const plan of caller.storage!.callTransports) {
				const target = plan.targets[0]!;
				expect(emitted.directEntryCalls.get(plan.instructionIp)).toContain(
					target.functionIndex,
				);
			}
			const fallback = emitCompiledFunction(caller, caller.functionIndex, "", false)!;
			expect(fallback.directEntryCalls.size).toBe(0);
			expect(fallback.source).not.toContain(
				`mal_callback_${callback.functionIndex}_${callback.entryId}`,
			);
			expect(
				emitProgramTranslationUnits(restored, { compiled: true })
					.map((unit) => unit.source)
					.join("\n"),
			).toContain(`mal_callback_${callback.functionIndex}_${callback.entryId}`);
		},
	);
});
