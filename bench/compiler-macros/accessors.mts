import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
const builder = new CoreFunctionBuilder(program);
const entry = builder.createBlock();
let value = builder.appendInstruction(entry, "createNumber", [], {
	attributes: { value: 1 },
})[0]!;
for (let index = 0; index < 384; index++) {
	const other = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: index },
	})[0]!;
	value = builder.appendInstruction(entry, "binary", [value, other], {
		attributes: { operator: "+" },
	})[0]!;
}
builder.setTerminator(entry, { kind: "return", value });
const fn = program.function(builder.finish(entry).function);
const instructions = [...fn.instructionIds()];
let checksum = 0;
const iterations = Number(process.argv[2] ?? 1);
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const instruction of instructions) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		checksum =
			(checksum +
				fn.instructionOpcodeName(instruction).length +
				fn.kernel.instructionOperandStart(instruction) +
				fn.kernel.instructionOperandCount(instruction)) |
			0;
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
