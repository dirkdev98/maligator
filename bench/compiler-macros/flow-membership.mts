import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgramFlowEngine } from "../../src/compiler/core/core-program-flow.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
for (let index = 0; index < 48; index++) {
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	let value = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: index },
	})[0]!;
	for (let operation = 0; operation < 64; operation++) {
		const other = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: operation },
		})[0]!;
		value = builder.appendInstruction(entry, "binary", [value, other], {
			attributes: { operator: "+" },
		})[0]!;
	}
	builder.setTerminator(entry, { kind: "return", value });
	builder.finish(entry);
}
const functions = [...program.functionIds()];
const initial = new CoreProgramFlowEngine(program);
for (const fn of functions) initial.local(fn);
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const value = builder.appendInstruction(entry, "createUndefined", [])[0]!;
	builder.setTerminator(entry, { kind: "return", value });
	builder.finish(entry);
	for (let consumer = 0; consumer < 4; consumer++) {
		const engine = new CoreProgramFlowEngine(program);
		for (const fn of functions) {
			const transfers = engine.local(fn);
			checksum = (checksum + transfers.recordCount + transfers.instructionVisits) | 0;
		}
	}
}
console.log(
	JSON.stringify({
		iterations,
		checksum: (checksum + program.functionCapacity) | 0,
		milliseconds: performance.now() - start,
	}),
);
