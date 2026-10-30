import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
const mode = process.argv[3] ?? "mixed";
for (let functionIndex = 0; functionIndex < 32; functionIndex++) {
	const builder = new CoreFunctionBuilder(program);
	const count = mode === "single" || functionIndex % 4 !== 0 ? 1 : 32;
	const blocks = Array.from({ length: count }, () => builder.createBlock());
	const entry = blocks[0]!;
	const condition = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	})[0]!;
	for (let index = 0; index < count; index++) {
		const block = blocks[index]!;
		if (index === count - 1)
			builder.setTerminator(block, { kind: "return", value: condition });
		else
			builder.setTerminator(block, {
				kind: "branch",
				condition,
				consequent: { block: blocks[index + 1]!, arguments: [] },
				alternate: { block: blocks[Math.min(count - 1, index + 3)]!, arguments: [] },
			});
	}
	builder.finish(entry);
}
const functions = [...program.functionIds()];
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const id of functions) {
		const fn = program.function(id);
		const cfg = buildCoreControlFlow(program, id);
		for (const block of cfg.reversePostorder) {
			checksum =
				(checksum +
					(cfg.immediateDominators[block] ?? -1) +
					Number(cfg.dominates(fn.entry, block)) +
					Number(cfg.dominates(block, fn.entry))) |
				0;
		}
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
