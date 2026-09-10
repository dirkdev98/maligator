import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const source = `function* probe(x,y,p){const s=String(x),n=String(y),i=+p;yield s;return s.includes(n,i);}globalThis.probe=probe;`;

describe("suspended builtin input certificates", () => {
	it.each([false, true])(
		"retains boxed roots and exact inputs across async=%s suspension and artifact roundtrip",
		(async) => {
			const out = inspectStaticValueFunction(
				async
					? source.replace("function*", "async function").replace("yield s", "await s")
					: source,
				"probe",
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			const index = out.image.runtime.functions.indexOf(out.fn);
			const fn = restored.runtime.functions[index]!;
			const native = restored.native.functions[index]!;
			expect(native.registerRepresentations.every((rep) => rep === "boxed")).toBe(true);
			const ip = fn.instructions.findIndex(
				(op) =>
					op.opcode === "CALL_KNOWN" && op.operation === "String.prototype.includes",
			);
			expect(native.instructions[ip]).toEqual({
				kind: "exact-builtin-input-kinds",
				inputKindMasks: [
					COMPILER_VALUE_KIND_STRING,
					COMPILER_VALUE_KIND_STRING,
					COMPILER_VALUE_KIND_NUMBER,
				],
			});
			expect(native.gc).toEqual(out.native.gc);
			const emitted = emitCompiledFunction(fn, native, index, "", false)!;
			expect(emitted.source).toContain("mal_builtin_string_search_strings(");
			expect(emitted.source).not.toContain("mal_builtin_string_search_direct(");
			expect(emitted.source.match(/mal_vm_call_known_native\(/g) ?? []).toHaveLength(2);
		},
	);

	it.each([
		"const n=yield s;",
		"const n=flag ? String(y) : yield s;",
		"let n=String(y); n=yield s;",
	])("retains unknown resumed values with %s", (body) => {
		const out = inspectStaticValueFunction(
			`function* probe(x,y,flag){const s=String(x);${body}return s.includes(n,0);}globalThis.probe=probe;`,
			"probe",
		);
		const ip = out.fn.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "String.prototype.includes",
		);
		expect(out.native.instructions[ip]).toEqual({
			kind: "exact-builtin-input-kinds",
			inputKindMasks: [
				COMPILER_VALUE_KIND_STRING,
				COMPILER_VALUE_KIND_TOP,
				COMPILER_VALUE_KIND_NUMBER,
			],
		});
		expect(out.c.source).toContain("mal_builtin_string_search_direct(");
		expect(out.c.source).not.toContain("mal_builtin_string_search_strings(");
	});

	it.each([
		[COMPILER_VALUE_KIND_STRING],
		[COMPILER_VALUE_KIND_STRING, 0, COMPILER_VALUE_KIND_NUMBER],
		[COMPILER_VALUE_KIND_STRING, 256, COMPILER_VALUE_KIND_NUMBER],
	])("rejects invalid builtin operand masks %j", (...masks) => {
		const out = inspectStaticValueFunction(source, "probe");
		const index = out.image.runtime.functions.indexOf(out.fn);
		const image = {
			...out.image,
			native: {
				...out.image.native,
				functions: out.image.native.functions.map((fn, i) =>
					i !== index
						? fn
						: {
								...fn,
								instructions: fn.instructions.map((plan) =>
									plan?.kind === "exact-builtin-input-kinds"
										? { ...plan, inputKindMasks: masks }
										: plan,
								),
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(image)).toThrow(
			/invalid builtin input kind masks/,
		);
	});
});
