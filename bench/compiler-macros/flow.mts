import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../../src/compiler/core/core-editor.ts";
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
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	// A fresh source epoch starts each replay with cold local-transfer state.
	CoreEditor.configureProgram(program, { sourcePositions: [] });
	for (let solve = 0; solve < 6; solve++) {
		const engine = new CoreProgramFlowEngine(program);
		for (const fn of functions) {
			const transfers = engine.local(fn);
			checksum = (checksum + transfers.recordCount + transfers.instructionVisits) | 0;
		}
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
