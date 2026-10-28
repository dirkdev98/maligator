import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_KNOWN_BUILTIN_EFFECT_FACT,
	coreKnownBuiltinInvocationEffects,
} from "../src/compiler/core/core-builtin-effects.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	cloneCoreFunction,
	coreFunctionIsCloneable,
} from "../src/compiler/core/core-function-clone.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";

describe("known builtin effects across cloning", () => {
	it.each(["Array.isArray", "JSON.isRawJSON"])(
		"reproves %s instead of copying the original proof",
		(operation) => {
			const program = analysisProgram();
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{}]);
			const input = builder.blockParameterValue(entry, 0);
			const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
			const [result] = builder.appendInstruction(entry, "callKnown", [receiver!, input], {
				attributes: { operation },
			});
			const instruction = builder.bodyInstructionIds(entry).at(-1)!;
			builder.setTerminator(entry, { kind: "return", value: result! });
			const fn = program.function(builder.finish(entry).function);
			const effects = coreKnownBuiltinInvocationEffects(fn, instruction)!;
			const edit = CoreEditor.open(program, fn.id);
			const proof = edit.addFact({
				kind: CORE_KNOWN_BUILTIN_EFFECT_FACT,
				value: operation,
				claims: [{ kind: "effect", instruction, effects }],
				validity: { kind: "summary", digest: operation },
				obligations: [],
				origin: "test",
			});
			edit.setInstructionEffectRefinement(instruction, { effects, proof });
			edit.commit();
			expect(coreFunctionIsCloneable(fn)).toBe(true);
			const clone = program.function(cloneCoreFunction(program, fn));
			const copied = [...clone.instructionIds()].find(
				(id) =>
					clone.instructionKind(id) === "operation" &&
					clone.instructionOpcodeName(id) === "callKnown",
			)!;
			expect(clone.instructionEffectRefinement(copied)).toBeUndefined();
			expect(coreKnownBuiltinInvocationEffects(clone, copied)).toEqual(effects);
			expect(fn.instructionEffectRefinement(instruction)?.proof).toBe(proof);
		},
	);
});
