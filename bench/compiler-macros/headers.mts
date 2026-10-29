import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import type { CoreInstructionId } from "../../src/compiler/core/core-ir.ts";
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
const read =
	typeof fn.instructionHeader === "function"
		? (instruction: CoreInstructionId): number => {
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") return 0;
				const attributes = fn.kernel.instructionAttributes(instruction);
				return (
					header.opcode.length +
					header.inputs.minimum +
					(typeof attributes.value === "number" ? attributes.value : 0)
				);
			}
		: (instruction: CoreInstructionId): number => {
				if (fn.instructionKind(instruction) !== "operation") return 0;
				const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
				const attributes = fn.instructionAttributes(instruction);
				return (
					descriptor.opcode.length +
					descriptor.inputs.minimum +
					(typeof attributes.value === "number" ? attributes.value : 0)
				);
			};
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const instruction of instructions) checksum = (checksum + read(instruction)) | 0;
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
