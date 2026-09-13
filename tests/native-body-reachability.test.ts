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
const predicate = "function isNil(x) { return x === null || x === undefined; }";

describe("native body reachability", () => {
	it("omits the generic C body and bytecode when every private use has a specialized entry", () => {
		const original = compile(`${predicate} console.log(isNil(true));`);
		for (const image of [
			original,
			deserializeCompilerArtifact(serializeCompilerArtifact(original)),
		]) {
			const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
			expect(index).toBeGreaterThan(0);
			for (const source of [
				emitProgramImage(image),
				emitProgramTranslationUnits(image)
					.map((unit) => unit.source)
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
		"globalThis.isNil = isNil; console.log(isNil(true));",
		"console.log(isNil(true)); globalThis.consume(isNil);",
		"const obj = { fn: isNil }; console.log(isNil(true)); globalThis.obj = obj;",
		'import * as ns from "./entry.mjs"; console.log(isNil(true)); export { isNil }; globalThis.ns = ns;',
		"console.log(isNil(true)); const functions = [isNil]; console.log(functions[globalThis.index](null));",
	])("retains generic native execution when the function can escape: %s", (suffix) => {
		const image = compile(predicate + suffix);
		expect(image.native.functions.some((fn) => fn.specializedOnly)).toBe(false);
	});
	it("retains the generic entry when a caller cannot select its typed arguments", () => {
		const image = compile(`${predicate} console.log(isNil(true));`);
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
		expect(emitProgramImage(withoutSelection)).toContain(`mal_compiled_${index}(`);
	});
	it("retains bytecode when compilation is disabled", () => {
		const image = compile(`${predicate} console.log(isNil(true));`);
		const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
		expect(emitProgramImage(image, { compiled: false })).toContain(
			`mal_function_${index}_instructions`,
		);
	});
	it("restores the canonical C body if selected entries are unavailable", () => {
		const image = compile(`${predicate} console.log(isNil(true));`);
		const index = image.native.functions.findIndex((fn) => fn.specializedOnly);
		const withoutEntries = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) => ({ ...fn, directEntries: [] })),
			},
		};
		expect(emitProgramImage(withoutEntries)).toContain(`mal_compiled_${index}(`);
	});
});
