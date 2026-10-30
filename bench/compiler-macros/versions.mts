import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import type { CoreInstructionId } from "../../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";
import type { CoreFunctionStore } from "../../src/compiler/core/core-store.ts";

function queryVersions(fn: CoreFunctionStore): number {
	let checksum = 0;
	for (let query = 0; query < 2048; query++) {
		checksum =
			(checksum +
				fn.version("body") +
				fn.version("calls") +
				fn.version("cfg") +
				fn.version("memoryEffects")) |
			0;
	}
	return checksum;
}

const program = new CoreProgram(coreOpcodeRegistry);
const builder = new CoreFunctionBuilder(program);
const entry = builder.createBlock();
const value = builder.appendInstruction(entry, "createNumber", [], {
	attributes: { value: 1 },
})[0]!;
builder.setTerminator(entry, { kind: "return", value });
const fn = program.function(builder.finish(entry).function);
const seed = fn.kernel.valueDefinitionOwner(value) as CoreInstructionId;
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	const editor = CoreEditor.open(program, fn.id);
	editor.replaceInstruction(seed, "createNumber", [], {
		attributes: { value: iteration },
	});
	editor.commit();
	checksum =
		(checksum +
			queryVersions(fn) +
			program.programVersion("functions") +
			program.functionVersion("body")) |
		0;
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
