import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const cases = [
	[
		"presence",
		"const receiver=pick(flag,observe);for(let i=0;i<receiver.length;i++){observe(i);if(i in receiver){const same=receiver[i]===expected[i];if(!same)return false;}}return true;",
	],
	[
		"primary",
		"const receiver=pick(flag,observe);for(let i=0;i<receiver.length;i++){observe(i);const same=receiver[i]===expected[i];if(!same)return false;}return true;",
	],
	[
		"secondary",
		"const receiver=pick(flag,observe);for(let i=0;i<expected.length;i++){observe(i);const same=expected[i]===receiver[i];if(!same)return false;}return true;",
	],
	[
		"destructure",
		"const receiver=pick(flag,observe);const [left,right]=receiver;return[left,right];",
	],
] as const;

describe("Array-only receiver admission", () => {
	it.each(cases)(
		"prunes impossible %s paths and retains protocol handling",
		(kind, body) => {
			const out = inspectStaticValueFunction(
				`const pick=function pick(flag,observe){observe(new.target);return flag?'A𝌆B':42;};globalThis.pick=pick;globalThis.compute=function compute(flag,expected,observe){${body}};`,
				"compute",
				{ locked: false },
			);
			for (const fn of [
				out.native,
				deserializeCompilerArtifact(serializeCompilerArtifact(out.image)).native
					.functions[out.native.functionIndex]!,
			]) {
				expect(fn.storage!.pairedArrayLoops).toEqual([]);
				expect(fn.storage!.arrayPresence).toEqual([]);
				expect(fn.storage!.arrayPairDestructure).toEqual([]);
				if (kind === "destructure")
					expect(
						fn.specializations.some(
							(region) => region.kind === "array-values-iterator-cursor",
						),
					).toBe(true);
			}
			expect(out.c.source).not.toContain("__paired_array_");
			expect(out.c.source).not.toContain("mal_vm_array_try_get_present_proven_index(");
			expect(out.c.source).not.toContain("mal_builtin_array_pair_destructure_try(");
			expect(out.c.source).not.toContain("mal_vm_array_values_deferred_begin(");
			for (const [ip, op] of out.native.body.instructions.entries()) {
				if (
					(op.opcode === "LOAD_PROPERTY_STATIC" || op.opcode === "LOAD_PROPERTY") &&
					instructionInputKind(out.native.facts?.[ip], op.object) ===
						(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING)
				) {
					expect(out.c.source).not.toContain(`mal_vm_as_array(r${op.object})`);
					expect(out.c.source).not.toContain(
						`mal_vm_admit_numeric_typed_array_length(vm, r${op.object},`,
					);
				}
			}
			if (kind === "destructure") expect(out.c.source).toContain("mal_vm_get_iterator(");
		},
	);
});
