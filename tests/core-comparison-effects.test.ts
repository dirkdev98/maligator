import { expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { corePrimitiveEffectRefinement } from "../src/compiler/core/core-ir-value-kinds.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_NULLISH as NULLISH,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_TOP as TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";

it.each([
	["String ordering", "<", STRING, STRING, false, false],
	["String/Number ordering", "<=", STRING, NUMBER, false, false],
	["String/Number union equality", "==", STRING | NUMBER, NUMBER, false, false],
	["Number/BigInt ordering", ">", NUMBER, BIGINT, false, false],
	["BigInt/String equality", "==", BIGINT, STRING, false, true],
	["String/BigInt ordering", ">=", STRING, BIGINT, false, true],
	["Symbol equality", "!=", SYMBOL, NUMBER, false, false],
	["Symbol ordering", "<", SYMBOL, NUMBER, true, true],
	["Object equality", "==", OBJECT, OBJECT, false, false],
	["nullable Object equality", "!=", OBJECT | NULLISH, OBJECT | NULLISH, false, false],
	["unknown nullish equality", "==", TOP, NULLISH, false, false],
	["unknown strict equality", "===", TOP, TOP, false, false],
	["strict String/BigInt equality", "!==", STRING, BIGINT, false, false],
	["Object/String equality", "==", OBJECT, STRING, undefined, undefined],
	["Object ordering", "<=", OBJECT, OBJECT, undefined, undefined],
	["unknown equality", "!=", TOP, TOP, undefined, undefined],
	["unseeded comparison", "<", 0, STRING, undefined, undefined],
	["String concatenation", "+", STRING, STRING, true, true],
] as const)(
	"preserves the effect contract of %s",
	(_name, operator, leftKind, rightKind, mayThrow, mayGc) => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const operands = inspectCoreBlockParameters(builder, entry).map(({ value }) => value);
		const [result] = builder.appendInstruction(entry, "binary", operands, {
			attributes: { operator },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = program.function(builder.finish(entry).function);
		const definition = inspectCoreValueDefinition(fn, result!);
		if (definition.kind !== "instruction") throw new Error("Missing comparison");
		const effects = corePrimitiveEffectRefinement(program, fn, definition.instruction, [
			leftKind,
			rightKind,
		]);
		if (mayThrow === undefined) expect(effects).toBeUndefined();
		else
			expect(effects).toEqual({
				reads: [],
				writes: [],
				mayThrow,
				mayGc,
				maySuspend: false,
				callsUserCode: false,
			});
	},
);
