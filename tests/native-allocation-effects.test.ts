import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { vmExceptionHandlerTargets } from "../src/compiler/target/runtime-image.ts";

describe("native fallible shaped allocation", () => {
	it.each(["empty", "shaped"])(
		"routes a noncollecting %s allocation error to the owning handler",
		(kind) => {
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`globalThis.create = function create(input) {
					try {
						const object = ${kind === "empty" ? "{}" : '{value: input, text: "literal"}'};
						globalThis.saved = object;
						return true;
					} catch(error) { return error instanceof Error; }
				};`,
					"/allocation-error.js",
				),
			);
			const fn = image.native.functions[1]!;
			const ip = fn.body.instructions.findIndex(
				(op) =>
					op.opcode === (kind === "empty" ? "CREATE_OBJECT" : "CREATE_OBJECT_SHAPED"),
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			expect(nativeInstructionEffects(fn.body.instructions[ip]!)).toEqual({
				allocation: true,
				collection: false,
				reentry: false,
				throwing: true,
				invalidation: false,
			});
			const handler = vmExceptionHandlerTargets(
				fn.body.instructions.length,
				fn.body.handlers,
			)[ip];
			expect(handler).toBeDefined();
			const output = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
			expect(output).toMatch(
				new RegExp(
					`${kind === "empty" ? "mal_vm_op_create_object" : "mal_vm_create_object_shaped"}\\([^\\n]+;\\n\\s*if \\(MAL_THREW\\(\\)\\) goto L${handler};`,
				),
			);
		},
	);
});
