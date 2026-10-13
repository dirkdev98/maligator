import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.count=function(record,hook){${body}};`,
			"/keys-count.js",
		),
	);
}
describe("Object.keys count storage", () => {
	it("retains snapshots through indexed traversal, calls, and aliases", () => {
		const image = compile(`const keys=Object.keys(record); const alias=keys;
			let size=0; for(let i=0;i<keys.length;i++){ const key=alias[i]; hook(record,key); size+=key.length; } return size;`);
		const native = image.native.functions[1]!;
		expect(native.storage!.objectKeysSnapshots).toHaveLength(1);
		expect(native.storage!.objectKeysSnapshots[0]!.elementIps).toHaveLength(1);
		expect(native.storage!.objectKeysSnapshots[0]!.lengthIps).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it("tracks indexed observers that can require materialization", () => {
		const image = compile(
			"const keys=Object.keys(record); return [keys[hook], keys.length, keys[0]];",
		);
		expect(
			image.native.functions[1]!.storage!.objectKeysSnapshots[0]!.elementIps,
		).toHaveLength(2);
	});
	it("retains a validated count projection through artifact loading and emission", () => {
		const image = compile("return Object.keys(record).length;");
		expect(image.native.functions[1]!.storage!.objectKeysSnapshots).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it.each([
		"const keys=Object.keys(record);hook(keys);return keys.length;",
		"const keys=Object.keys(record);return [keys.length, keys];",
		"const keys=Object.keys(record);keys.push('extra');return keys.length;",
		"let keys=Object.keys(record); if(hook) keys=['other']; return keys[0];",
		"const keys=Object.keys(record);keys[0]='extra';return keys.length;",
	])("retains an observable array: %s", (body) => {
		expect(compile(body).native.functions[1]!.storage!.objectKeysSnapshots).toEqual([]);
	});
	it("rejects forged consumers and missing claimed instructions", () => {
		const image = compile("return Object.keys(record).length;"),
			native = image.native.functions[1]!;
		const plan = native.storage!.objectKeysSnapshots[0]!;
		for (const forged of [
			{ ...plan, lengthIps: [plan.callIp] },
			{ ...plan, claimedIps: [plan.callIp] },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, objectKeysSnapshots: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
});
