import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import type { CoreInstructionId } from "../../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
const builder = new CoreFunctionBuilder(program);
const entry = builder.createBlock();
const value = builder.appendInstruction(entry, "createNumber", [], {
	attributes: { value: 1 },
})[0]!;
builder.setTerminator(entry, { kind: "return", value });
const fn = program.function(builder.finish(entry).function);
const valid = [...fn.bodyInstructionIds(entry)][0]!;
const invalid = (fn.instructionCapacity + 1) as CoreInstructionId;
const expected = `Unknown Core instruction ${invalid}`;
const read =
	typeof fn.instructionHeader === "function"
		? (instruction: CoreInstructionId) =>
				typeof fn.instructionHeader(instruction) === "string" ? 0 : 1
		: (instruction: CoreInstructionId) =>
				fn.instructionKind(instruction) === "operation" ? 1 : 0;
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (let query = 0; query < 128; query++) {
		try {
			checksum = (checksum + read((query & 1) === 0 ? valid : invalid)) | 0;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== expected) throw error;
			checksum = (checksum + error.message.length) | 0;
		}
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
