import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
const builder = new CoreFunctionBuilder(program);
const entry = builder.createBlock();
const value = builder.appendInstruction(entry, "createNumber", [], {
	attributes: { value: 1 },
})[0]!;
builder.setTerminator(entry, { kind: "return", value });
const fn = program.function(builder.finish(entry).function);
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	const editor = CoreEditor.open(program, fn.id);
	editor.appendInstruction(entry, "createNumber", [], {
		attributes: { value: iteration },
	});
	editor.commit();
	for (let query = 0; query < 2048; query++) {
		checksum =
			(checksum +
				fn.version("body") +
				fn.version("calls") +
				fn.version("cfg") +
				fn.version("memoryEffects") +
				program.programVersion("functions") +
				program.functionVersion("body")) |
			0;
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
