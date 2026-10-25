import { expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { analyzeCoreNativeEntryControlFlow } from "../src/compiler/core/core-native-entry-reachability.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
} from "../src/compiler/shared/compiler-value-kinds.ts";

const safeRange = (minimum: number, maximum: number) => ({
	minimum,
	maximum,
	exactSafeIntegers: true as const,
	excludesNegativeZero: true as const,
});

it.each(["negation", "comparison"])(
	"keeps %s input ranges local to their consumer",
	(operation) => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const first = builder.createBlock(),
			second = builder.createBlock();
		const firstTrue = builder.createBlock(),
			firstFalse = builder.createBlock();
		const secondTrue = builder.createBlock(),
			secondFalse = builder.createBlock();
		const input = builder.blockParameterValue(entry, 0),
			flag = builder.blockParameterValue(entry, 1);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: first, arguments: [] },
			alternate: { block: second, arguments: [] },
		});
		const [zero] = builder.appendInstruction(first, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [condition] =
			operation === "negation"
				? builder.appendInstruction(first, "unary", [input], {
						attributes: { operator: "!" },
					})
				: builder.appendInstruction(first, "binary", [input, zero!], {
						attributes: { operator: "<" },
					});
		builder.setTerminator(first, {
			kind: "branch",
			condition: condition!,
			consequent: { block: firstTrue, arguments: [] },
			alternate: { block: firstFalse, arguments: [] },
		});
		builder.setTerminator(second, {
			kind: "branch",
			condition: input,
			consequent: { block: secondTrue, arguments: [] },
			alternate: { block: secondFalse, arguments: [] },
		});
		for (const block of [firstTrue, firstFalse, secondTrue, secondFalse])
			builder.setTerminator(block, { kind: "return", value: input });
		const id = builder.finish(entry).function;
		const fn = program.function(id),
			cfg = buildCoreControlFlow(program, id);
		const kinds = analyzeCoreValueKinds(fn, cfg, {
			parameterMasks: [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_BOOLEAN],
		});
		const reachable = analyzeCoreNativeEntryControlFlow(
			program,
			fn,
			cfg,
			kinds,
			[],
			(value, block) =>
				value === zero
					? safeRange(0, 0)
					: value !== input
						? undefined
						: block === first
							? safeRange(1, 3)
							: block === second
								? safeRange(0, 0)
								: undefined,
		);
		expect(reachable.blocks).toEqual(
			new Set([entry, first, second, firstFalse, secondFalse]),
		);
	},
);
