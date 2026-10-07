import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(source: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "/fast-path-storage.js"),
	);
}

function compileConstructor() {
	return compile(`globalThis.Record = class Record {
		#left=1; #right=2;
		constructor(value) { this.a=value; this.b=value; }
	};`);
}

describe("persisted native array and constructor fast paths", () => {
	it("retains paired-loop receiver ownership and replays the stored selection", () => {
		const image =
			compile(`globalThis.paired = function paired(values, expected, callback) {
			for(let i=0;i<values.length;i++) {
				callback(i, values, expected);
				if(i in values) { const same=values[i]===expected[i]; if(!same)return false; }
			}
			return true;
		};`);
		const original = image.native.functions.find(
			(fn) => fn.storage!.pairedArrayLoops.length > 0,
		)!;
		expect(original).toBeDefined();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const fn = restored.native.functions[original.functionIndex]!;
		expect(fn.storage).toEqual(original.storage);
		const plan = fn.storage!.pairedArrayLoops[0]!;
		for (const receiver of [plan.primaryObject, plan.secondaryObject]) {
			expect(plan.borrowedRegisters).toContain(receiver);
			expect(fn.storage!.privateRegisters).not.toContain(receiver);
		}
		for (const ip of plan.claimedIps) expect(fn.storage!.expressionIps).not.toContain(ip);
		const replay = lowerNativeFastPaths(
			fn.body,
			fn.registerRepresentations,
			new Set(plan.claimedIps),
			() => true,
			{ kind: "render", plans: fn.storage! },
		);
		expect(replay.pairedArrayLoopActions.get(plan.lengthLoadIp)?.role).toBe("admit");
		expect(replay.pairedArrayLoopActions.get(plan.secondaryLoadIp)?.role).toBe("load");
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)!.source).toContain(
			"mal_vm_array_try_get_proven_index(__paired_array_",
		);
		for (const forged of [
			{ ...plan, secondaryObject: plan.primaryObject },
			{ ...plan, key: plan.key + 1 },
			{ ...plan, claimedIps: [plan.lengthLoadIp] },
			{ ...plan, borrowedRegisters: [] },
		])
			expect(() =>
				validateNativeStorage({
					...fn,
					storage: { ...fn.storage!, pairedArrayLoops: [forged] },
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("selects one admission when two comparisons share a parent length site", () => {
		const image = compile(`globalThis.paired = function paired(values, expected, other) {
			for(let i=0;i<values.length;i++) {
				const same=values[i]===expected[i]; const also=values[i]===other[i];
				if(!same || !also)return false;
			}
			return true;
		};`);
		const fn = image.native.functions[1]!;
		expect(fn.storage!.pairedArrayLoops).toHaveLength(1);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(image)).native.functions[1]!
				.storage,
		).toEqual(fn.storage);
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
	});

	it("stores constructor references and private capacity separately from rendered actions", () => {
		const image = compileConstructor();
		const original = image.native.functions.find((fn) => fn.body.isClassConstructor)!;
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const fn = restored.native.functions[original.functionIndex]!;
		expect(fn.storage).toEqual(original.storage);
		const constructor = fn.storage!.constructorInitialization!;
		const privateFields = fn.storage!.privateFieldReserve!;
		expect(constructor.stores).toHaveLength(2);
		expect(privateFields.count).toBeGreaterThanOrEqual(2);
		const replay = lowerNativeFastPaths(
			fn.body,
			fn.registerRepresentations,
			new Set(constructor.claimedIps),
			() => true,
			{ kind: "render", plans: fn.storage! },
		);
		for (const [index, ip] of constructor.stores.entries()) {
			const action = replay.constructorInitializationActions.get(ip)!;
			expect(action.index).toBe(index);
			expect(action.stores[index]).toBe(fn.body.instructions[ip]);
		}
		expect(replay.privateFieldReserve).toBe(privateFields);
		const emitted = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
		expect(emitted).toContain("mal_vm_constructor_try_begin_initialization(");
		expect(emitted).toContain("mal_vm_reserve_private_elements(");
		for (const forged of [
			{ ...constructor, stores: [...constructor.stores].reverse() },
			{ ...constructor, claimedIps: [constructor.id] },
			{ ...constructor, borrowedRegisters: [] },
		])
			expect(() =>
				validateNativeStorage({
					...fn,
					storage: { ...fn.storage!, constructorInitialization: forged },
				}),
			).toThrow(/invalid or stale storage plan/);
		expect(() =>
			validateNativeStorage({
				...fn,
				storage: {
					...fn.storage!,
					privateFieldReserve: { ...privateFields, count: privateFields.count + 1 },
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("declines eager constructor shape publication across callbacks and fallible allocations", () => {
		for (const initializer of ["callback()", "globalThis.saved = {}"]) {
			const image = compile(
				`globalThis.Record = class Record { constructor(value, callback) { this.a=value; ${initializer}; this.b=value; } };`,
			);
			const fn = image.native.functions.find((fn) => fn.body.isClassConstructor)!;
			expect(fn.storage!.constructorInitialization).toBeUndefined();
			expect(emitCompiledFunction(fn, fn.functionIndex, "", false)!.source).not.toContain(
				"mal_vm_constructor_try_begin_initialization(",
			);
		}
	});

	it("keeps derived constructors on their original initialization path", () => {
		const image = compile(
			`class Base {} globalThis.Record = class Record extends Base { #a=1; #b=2; constructor(value) { super(); this.a=value; this.b=value; } };`,
		);
		const fn = image.native.functions.find((fn) => fn.body.isDerivedConstructor)!;
		expect(fn.storage!.constructorInitialization).toBeUndefined();
		expect(fn.storage!.privateFieldReserve).toBeUndefined();
	});
});
