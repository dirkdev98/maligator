import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	readCompilerProfiling,
	writeCompilerProfiling,
} from "../src/compiler/target/compiler-profile-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import {
	Reader,
	Writer,
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";

function compile(profile = true) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			'function dispatch(value,g){const items=[value,1,2];g(items);switch(value){case "load":return items[1];case "save":return items[2];default:return -1;}}globalThis.dispatch=dispatch;globalThis.result=dispatch(String(globalThis.input),globalThis.g);',
			"profile-codec.mjs",
		),
		{
			profile,
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "locked" } }),
			),
		},
	);
}

describe.each(["precise", "conservative"] as const)(
	"%s profile artifact contract",
	(roots) => {
		it.each([true, false])(
			"restores all code-affecting tables, facts and plans with debug %s",
			(debugInfo) => {
				const image = lowerNativeStorage(compile(), roots);
				const restored = deserializeCompilerArtifact(
					serializeCompilerArtifact(image, { debugInfo }),
				);
				expect(restored.profiling).toEqual(image.profiling);
				expect(restored.runtime.functions.map((fn) => fn.profileSiteIds)).toEqual(
					image.runtime.functions.map((fn) => fn.profileSiteIds),
				);
				for (const [index, fn] of restored.native.functions.entries()) {
					const original = image.native.functions[index]!;
					expect(fn.body.profileSiteIds).toEqual(original.body.profileSiteIds);
					expect(fn.compilerSiteIds).toEqual(original.compilerSiteIds);
					expect(fn.facts).toEqual(original.facts);
					expect(fn.directEntries).toEqual(original.directEntries);
					expect(fn.storage).toEqual(original.storage);
				}
				expect(emitProgramImage(restored, { compiled: true, debugInfo })).toBe(
					emitProgramImage(image, { compiled: true, debugInfo }),
				);
			},
		);
	},
);

it("restores the formerly invalid profiled array and keeps instrumentation outside runtime wires", () => {
	const image = lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				"globalThis.result=[1,2,3];",
				"profile-array.js",
			),
			{ profile: true },
		),
	);
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
	const source = emitProgramImage(restored, { compiled: true });
	expect(source).toContain(`.profile_site_count = ${image.profiling!.sites.length}`);
	expect(source).toContain("MAL_FRAME_SITE(");
	const wire = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
	expect(wire.functions.every((fn) => fn.profileSiteIds === undefined)).toBe(true);
});

it("preserves UTF-16 identities and sparse compiler-site tables", () => {
	const image = lowerNativeStorage(compile());
	const text = "file\0😀\ud800";
	const changed: ProgramImage = {
		...image,
		profiling: { sites: image.profiling!.sites.map((site) => ({ ...site, file: text })) },
		native: {
			...image.native,
			functions: image.native.functions.map((fn) => ({
				...fn,
				compilerSiteIds: Array.from({ length: fn.body.instructions.length }, (_, ip) =>
					ip % 2 === 0 ? text : undefined,
				),
			})),
		},
	};
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(changed));
	expect(restored.profiling).toEqual(changed.profiling);
	expect(restored.native.functions.map((fn) => fn.compilerSiteIds)).toEqual(
		changed.native.functions.map((fn) => fn.compilerSiteIds),
	);
});

it("keeps ordinary artifacts free of profile catalogs and instruction tables", () => {
	const image = lowerNativeStorage(compile(false));
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
	expect(restored.profiling).toBeUndefined();
	expect(
		restored.native.functions.every(
			(fn) => fn.compilerSiteIds === undefined && fn.body.profileSiteIds === undefined,
		),
	).toBe(true);
});

it("retains profiling restrictions when every instruction site is unknown", () => {
	const image = compile();
	const unknown = (fn: BytecodeFunction): BytecodeFunction => ({
		...fn,
		profileSiteIds: new Array<number>(fn.instructions.length).fill(-1),
	});
	const profiled = lowerNativeStorage({
		...image,
		profiling: { sites: [] },
		runtime: { ...image.runtime, functions: image.runtime.functions.map(unknown) },
		native: {
			...image.native,
			functions: image.native.functions.map((fn) => ({ ...fn, body: unknown(fn.body) })),
		},
	});
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(profiled));
	expect(restored.profiling).toEqual({ sites: [] });
	expect(restored.native.functions.map((fn) => fn.body.profileSiteIds)).toEqual(
		profiled.native.functions.map((fn) => fn.body.profileSiteIds),
	);
	expect(restored.native.functions.map((fn) => fn.storage)).toEqual(
		profiled.native.functions.map((fn) => fn.storage),
	);
});

it("preserves compiler instruction identities independently of profiling", () => {
	const image = lowerNativeStorage(compile(false));
	const native = {
		...image.native,
		functions: image.native.functions.map((fn) => ({
			...fn,
			compilerSiteIds: fn.body.instructions.map((_, index) => `site:${index}`),
		})),
	};
	const restored = deserializeCompilerArtifact(
		serializeCompilerArtifact({ ...image, native }),
	);
	expect(restored.profiling).toBeUndefined();
	expect(restored.native.functions.map((fn) => fn.compilerSiteIds)).toEqual(
		native.functions.map((fn) => fn.compilerSiteIds),
	);
});

it.each(["runtime", "native"] as const)("rejects orphaned %s profile tables", (body) => {
	const image = compile();
	const stripped = { ...image, profiling: undefined };
	if (body === "runtime")
		for (const fn of stripped.native.functions) fn.body.profileSiteIds = undefined;
	else for (const fn of stripped.runtime.functions) fn.profileSiteIds = undefined;
	expect(() => serializeCompilerArtifact(stripped)).toThrow(/instruction profile sites/);
});

it.each([
	{ id: 1 },
	{ functionIndex: -1 },
	{ instructionIndex: -1 },
	{ positionId: -1 },
	{ line: 0 },
	{ column: -1 },
	{ inlineChain: [{ functionIndex: -1, positionId: 0 }] },
])("rejects malformed profile-site fields %j", (changes) => {
	const image = compile();
	const sites = image.profiling!.sites.map((site, index) =>
		index === 0 ? { ...site, ...changes } : site,
	);
	expect(() => serializeCompilerArtifact({ ...image, profiling: { sites } })).toThrow(
		/invalid profile site/,
	);
});

it("rejects malformed profile and compiler identity tables before encoding", () => {
	for (const invalid of [undefined, NaN, 0.5, -2, 0x7fffffff]) {
		const image = compile();
		const fn = image.runtime.functions[0]!;
		const ids = new Array<number>(fn.instructions.length).fill(-1);
		if (invalid !== undefined) ids[0] = invalid;
		fn.profileSiteIds = invalid === undefined ? [] : ids;
		expect(() => serializeCompilerArtifact(image)).toThrow(/instruction profile sites/);
	}
	const image = compile();
	expect(() =>
		serializeCompilerArtifact({
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) => ({ ...fn, compilerSiteIds: [] })),
			},
		}),
	).toThrow(/invalid compiler sites/);
});

function emptyProfileFunction(): BytecodeFunction {
	return {
		...compile(false).runtime.functions[0]!,
		instructions: [{ opcode: "RETURN", value: 0 }],
	};
}

it.each([4, 255])("rejects unknown profiling flags %s", (flags) => {
	const fn = emptyProfileFunction();
	expect(() =>
		readCompilerProfiling(new Reader(Uint8Array.of(flags)), [fn], [fn]),
	).toThrow(/profiling flags/);
});

it.each([0, -2])("rejects decoded site ID %s without a catalog entry", (id) => {
	const fn = emptyProfileFunction();
	const writer = new Writer();
	writer.u8(1);
	writer.u32(0);
	writer.u8(1);
	writer.i32Array([id]);
	writer.u8(0);
	expect(() => readCompilerProfiling(new Reader(writer.finish()), [fn], [fn])).toThrow(
		/instruction profile sites/,
	);
});

it("rejects truncated instrumentation and invalid per-entry tags", () => {
	const image = compile();
	const writer = new Writer();
	writeCompilerProfiling(writer, image);
	const bytes = writer.finish();
	expect(() =>
		readCompilerProfiling(
			new Reader(bytes.slice(0, -1)),
			image.runtime.functions,
			image.native.functions.map((fn) => fn.body),
		),
	).toThrow(/truncated/);
	const fn = emptyProfileFunction();
	expect(() =>
		readCompilerProfiling(new Reader(Uint8Array.of(1, 0, 2)), [fn], [fn]),
	).toThrow(/profile table tag/);
	expect(() =>
		readCompilerProfiling(new Reader(Uint8Array.of(2, 1, 1, 2)), [fn], [fn]),
	).toThrow(/compiler site tag/);
});
