import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { selectNativeObjectEnumerationSnapshots } from "../src/compiler/target/native-object-enumeration-snapshot.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.count=function inspect(record,hook){${body}};`,
				"/enumeration-snapshot.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials } }),
				),
			},
		),
		"precise",
	);
}
function inspect(image: ReturnType<typeof compile>) {
	const native = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "inspect",
	);
	if (native === undefined) throw new Error("Missing inspect function");
	return native;
}
describe("Object enumeration snapshot storage", () => {
	it.each(["mutable", "locked"] as const)(
		"retains enumeration snapshots after independent handlers and in catch bodies under %s primordials",
		(mode) => {
			for (const kind of ["keys", "values", "entries"] as const)
				for (const body of [
					`try{hook();}catch(error){hook(error);}const result=Object.${kind}(record);hook(record);return [result[0],result.length];`,
					`try{hook();}catch(error){const result=Object.${kind}(record);hook(record);return [result[0],result.length];}return null;`,
					`try{hook();}catch(error){hook(error);}try{hook(record);}catch(error){hook(error);}const result=Object.${kind}(record);return [result[0],result.length];`,
				]) {
					const image = compile(body, mode),
						native = inspect(image);
					expect(native.body.handlers.length).toBeGreaterThan(0);
					expect(native.storage!.objectEnumerationSnapshots).toHaveLength(1);
					expect(native.storage!.objectEnumerationSnapshots[0]!.kind).toBe(kind);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					expect(() => emitProgramImage(image, {})).not.toThrow();
				}
		},
	);
	it.each(["keys", "values", "entries"] as const)(
		"declines %s snapshots whose aliases or producer reach exception boundaries",
		(kind) => {
			for (const body of [
				`try{const result=Object.${kind}(record);return result.length;}catch(error){return error;}`,
				`const result=Object.${kind}(record);try{hook();}catch(error){return result[0];}return result.length;`,
				`const result=Object.${kind}(record);try{hook();}finally{hook(result[0]);}return result.length;`,
				`const result=Object.${kind}(record);const size=result.length;try{hook();}catch(error){}return size;`,
				`let previous;for(let i=0;i<3;i++){try{hook();}catch(error){}const result=Object.${kind}(record);if(previous)hook(previous[0]);previous=result;}return previous.length;`,
				`let result=Object.${kind}(record);try{hook();}catch(error){result=[];}return result[0];`,
			])
				expect(inspect(compile(body)).storage!.objectEnumerationSnapshots, body).toEqual(
					[],
				);
		},
	);
	it("revalidates transported snapshot lifetimes against changed exception edges", () => {
		const image = compile(
				"const result=Object.values(record);return [result[0],result.length];",
			),
			native = inspect(image),
			plan = native.storage!.objectEnumerationSnapshots[0]!;
		const handlerIp = native.body.instructions.length - 1;
		for (const startIp of [plan.callIp, plan.elementIps[0]!])
			expect(() =>
				validateNativeStorage(
					{
						...native,
						body: {
							...native.body,
							handlers: [{ startIp, endIp: handlerIp, handlerIp }],
						},
					},
					undefined,
					image.runtime.stringConstants,
				),
			).toThrow(/invalid or stale storage plan/);
	});
	it.each([
		"const keys=Object.keys({ first:record, second:hook });return [keys[hook],keys.length];",
		"const keys=Object.keys(hook(record));return [keys[0],keys.length];",
	])("retains the captured builtin across argument preparation: %s", (source) => {
		const image = compile(source);
		expect(inspect(image).storage!.objectEnumerationSnapshots).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it("bounds lifetime analysis even when earlier key snapshots escape", () => {
		const source = (escapes: number) =>
			`${"hook(Object.keys(record));".repeat(escapes)} return Object.keys(record).length;`;
		expect(inspect(compile(source(4))).storage!.objectEnumerationSnapshots).toHaveLength(
			1,
		);
		expect(inspect(compile(source(64))).storage!.objectEnumerationSnapshots).toHaveLength(
			0,
		);
	});
	it("retains snapshots through indexed traversal, calls, and aliases", () => {
		const image = compile(`const keys=Object.keys(record); const alias=keys;
			let size=0; for(let i=0;i<keys.length;i++){ const key=alias[i]; hook(record,key); size+=key.length; } return size;`);
		const native = inspect(image);
		expect(native.storage!.objectEnumerationSnapshots).toHaveLength(1);
		expect(native.storage!.objectEnumerationSnapshots[0]!.elementIps).toHaveLength(1);
		expect(native.storage!.objectEnumerationSnapshots[0]!.lengthIps).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it("tracks indexed observers that can require materialization", () => {
		const image = compile(
			"const keys=Object.keys(record); return [keys[hook], keys.length, keys[0]];",
		);
		expect(
			inspect(image).storage!.objectEnumerationSnapshots[0]!.elementIps,
		).toHaveLength(2);
	});
	it("retains a validated count projection through artifact loading and emission", () => {
		const image = compile("return Object.keys(record).length;");
		expect(inspect(image).storage!.objectEnumerationSnapshots).toHaveLength(1);
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
		expect(inspect(compile(body)).storage!.objectEnumerationSnapshots).toEqual([]);
	});
	it.each(["mutable", "locked"] as const)(
		"captures values through calls and length-only observations under %s primordials",
		(mode) => {
			for (const body of [
				"const values=Object.values(record);hook(record);return values.length;",
				"const values=Object.values(record);const alias=values;hook(record);return [alias[0],values[hook],values.length];",
			]) {
				const image = compile(body, mode),
					native = inspect(image);
				const [plan] = native.storage!.objectEnumerationSnapshots;
				expect(plan?.kind).toBe("values");
				const source = emitCompiledFunction(
					native,
					native.functionIndex,
					"",
					false,
				)!.source;
				expect(source).toContain(
					plan!.elementIps.length > 0
						? "mal_builtin_object_enumeration_snapshot"
						: "mal_builtin_object_enumeration_count",
				);
				expect(source).toContain("MAL_OBJECT_ENUMERATION_VALUES");
				expect(source).not.toContain(
					plan!.elementIps.length > 0
						? "mal_builtin_object_enumeration_count"
						: "mal_builtin_object_enumeration_snapshot",
				);
				expect(source).toContain(
					`MalValue __gc_slots[${native.storage!.rootSlotCount + (plan!.elementIps.length > 0 ? 17 : 0)}];`,
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);
	it.each([
		"const values=Object.values(record);hook(values);return values.length;",
		"const values=Object.values(record);return [values.length,values];",
		"let values=Object.values(record);if(hook)values=[];return values[0];",
		"const values=Object.values(record);values[0]=hook;return values.length;",
	])("keeps observable values arrays: %s", (body) => {
		expect(inspect(compile(body)).storage!.objectEnumerationSnapshots).toEqual([]);
	});
	it("declines large unrelated callee and consumer names without decoding them", () => {
		const image = compile("return Object.values(record).length;"),
			native = inspect(image);
		expect(native.storage!.objectEnumerationSnapshots).toHaveLength(1);
		for (const name of ["values", "length"]) {
			const index = image.runtime.stringConstants.findIndex(
				(units) => String.fromCharCode(...units) === name,
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const strings = image.runtime.stringConstants.with(
				index,
				Array.from({ length: 150000 }, () => 120),
			);
			expect(
				selectNativeObjectEnumerationSnapshots(
					native,
					analyzeNativeBodyFacts(native.body),
					strings,
					() => false,
				),
			).toEqual([]);
		}
	});
	it("rejects forged consumers and missing claimed instructions", () => {
		const image = compile("return Object.keys(record).length;"),
			native = inspect(image);
		const plan = native.storage!.objectEnumerationSnapshots[0]!;
		for (const forged of [
			{ ...plan, kind: "values" as const },
			{ ...plan, lengthIps: [plan.callIp] },
			{ ...plan, claimedIps: [plan.callIp] },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(
							image.native.functions.indexOf(native),
							{
								...native,
								storage: { ...native.storage!, objectEnumerationSnapshots: [forged] },
							},
						),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
});
