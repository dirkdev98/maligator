import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("guarded dense Array search lowering", () => {
	it.each([
		["includes", false],
		["includes", true],
		["indexOf", false],
		["indexOf", true],
	] as const)(
		"retains loaded-callee fallback authority for %s with locked=%s",
		(method, locked) => {
			const out = inspectStaticValueFunction(
				`function search(array,needle,fromIndex){return array.${method}(needle,fromIndex);}globalThis.search=search;`,
				"search",
				{ locked },
			);
			const ip = out.native.body.instructions.findIndex(
				(op, index) =>
					op.opcode === "CALL" && out.native.instructions[index]?.kind === "call",
			);
			const plan = out.native.instructions[ip];
			expect(plan?.kind === "call" ? plan.guardedBuiltinCall?.operation : undefined).toBe(
				`Array.prototype.${method}`,
			);
			expect(out.c.source).toContain(
				method === "includes"
					? "mal_builtin_array_includes_try"
					: "mal_builtin_array_index_of_try",
			);
			expect(out.c.source).toContain("mal_vm_call_cached");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
});
