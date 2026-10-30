import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import type { GeneratedTranslationUnit } from "../src/compiler/target/emit-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { resolveSplitUnits } from "./helpers/native-relocation.ts";

function emitResolvedTranslationUnits(
	image: ProgramImage,
	...rest: Parameters<typeof emitProgramTranslationUnits> extends [unknown, ...infer Rest]
		? Rest
		: never
): Array<GeneratedTranslationUnit> {
	return resolveSplitUnits(image, emitProgramTranslationUnits(image, ...rest));
}

function compile(source: string) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mal-native-body-"));
	try {
		const file = path.join(dir, "entry.mjs");
		writeFileSync(file, source);
		return compileEntrypoint(file, { buildConfig: resolveBuildConfig({}) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const predicate =
	"function allNil(values) { let count = 0; for (let index = 0; index < 30; index++) { if (values[index] === null || values[index] === undefined) count++; } return count === 30; }";

describe("native body reachability", () => {
	it("omits the generic C body and bytecode when every private use has a specialized entry", () => {
		const original = compile(`${predicate} console.log(allNil(globalThis.values));`);
		for (const image of [
			original,
			deserializeCompilerArtifact(serializeCompilerArtifact(original)),
		]) {
			const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
			expect(index).toBeGreaterThan(0);
			for (const source of [
				emitProgramImage(image),
				emitResolvedTranslationUnits(image)
					.map((unit) => unit.sourceChunks.join(""))
					.join("\n"),
			]) {
				expect(source).toContain(`mal_direct_${index}_0(`);
				expect(source).not.toContain(`mal_compiled_${index}(`);
				expect(source).not.toContain(`mal_function_${index}_instructions`);
			}
			expect(image.runtime.functions[index]!.instructions.length).toBeGreaterThan(0);
		}
	});
	it.each([
		"globalThis.allNil = allNil; console.log(allNil(globalThis.values));",
		"console.log(allNil(globalThis.values)); globalThis.consume(allNil);",
		"const obj = { fn: allNil }; console.log(allNil(globalThis.values)); globalThis.obj = obj;",
		'import * as ns from "./entry.mjs"; console.log(allNil(globalThis.values)); export { allNil }; globalThis.ns = ns;',
		"console.log(allNil(globalThis.values)); const functions = [allNil]; console.log(functions[globalThis.index](null));",
	])("retains generic native execution when the function can escape: %s", (suffix) => {
		const image = compile(predicate + suffix);
		expect(image.native.functions.some((fn) => fn.specializedOnly)).toBe(false);
	});
	it("retains the generic entry when a caller cannot select its direct entry", () => {
		const image = compile(`${predicate} console.log(allNil(globalThis.values));`);
		const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
		const withoutSelection = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) => ({
					...fn,
					instructions: fn.instructions.map((instruction) =>
						instruction?.kind === "call"
							? { ...instruction, directEntryId: undefined }
							: instruction,
					),
				})),
			},
		};
		expect(emitProgramImage(lowerNativeStorage(withoutSelection))).toContain(
			`mal_compiled_${index}(`,
		);
	});
	it("retains bytecode when compilation is disabled", () => {
		const image = compile(`${predicate} console.log(allNil(globalThis.values));`);
		const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
		expect(emitProgramImage(image, { compiled: false })).toContain(
			`mal_function_${index}_instructions`,
		);
	});
	it("restores the canonical C body if selected entries are unavailable", () => {
		const image = compile(`${predicate} console.log(allNil(globalThis.values));`);
		const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
		const withoutEntries = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) => ({ ...fn, directEntries: [] })),
			},
		};
		expect(emitProgramImage(lowerNativeStorage(withoutEntries))).toContain(
			`mal_compiled_${index}(`,
		);
	});
});
