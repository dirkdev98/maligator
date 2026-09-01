import { describe, expect, it } from "vitest";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "local-passes.js",
		moduleEvaluationOrder: ["local-passes.js"],
		sourceFiles: [{ path: "local-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

describe("Core local canonicalization", () => {
	it("folds constants and branches while removing copies, dead code, and stale blocks", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const taken = builder.createBlock();
		const skipped = builder.createBlock();
		const forwarding = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], {
			attributes: { operator: "+" },
		});
		const [copy] = builder.appendInstruction(entry, "move", [sum!]);
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 99 },
		});
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: taken, arguments: [] },
			alternate: { block: skipped, arguments: [] },
		});
		builder.setTerminator(taken, {
			kind: "jump",
			edge: { block: forwarding, arguments: [copy!] },
		});
		const [unreachable] = builder.appendInstruction(skipped, "createNumber", [], {
			attributes: { value: -1 },
		});
		builder.setTerminator(skipped, { kind: "return", value: unreachable! });
		builder.setTerminator(forwarding, {
			kind: "jump",
			edge: {
				block: exit,
				arguments: [builder.blockParameters(forwarding)[0]!.value],
			},
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.blockParameters(exit)[0]!.value,
		});
		builder.finish(entry);

		const { compilation, report } = optimizeCore({ program, context });
		const fn = compilation.program.function(0 as never);
		const opcodes = [...fn.blockIds()].flatMap((block) =>
			[...fn.bodyInstructionIds(block)].map((instruction) =>
				fn.instructionOpcodeName(instruction),
			),
		);
		expect(opcodes).not.toContain("binary");
		expect(opcodes).not.toContain("move");
		expect([...fn.blockIds()].length).toBeLessThan(5);
		expect(report.output.instructions).toBeLessThan(report.input.instructions);
		expect(
			report.passes.find(({ pass }) => pass === "local-constant-folding"),
		).toMatchObject({ changedItems: 1 });
		expect(
			report.passes.find(({ pass }) => pass === "unreachable-block-removal"),
		).toMatchObject({ changedItems: 1 });
	});
});
