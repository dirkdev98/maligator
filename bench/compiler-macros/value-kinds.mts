import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { analyzeCoreValueKinds } from "../../src/compiler/core/core-ir-value-kinds.ts";
import { coreInstructionId } from "../../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
const builder = new CoreFunctionBuilder(program);
const entry = builder.createBlock();
const seed = builder.appendInstruction(entry, "createNumber", [], {
	attributes: { value: 1 },
})[0]!;
const values = [seed];
let value = seed;
for (let index = 0; index < 384; index++) {
	value = builder.appendInstruction(entry, "binary", [value, seed], {
		attributes: { operator: "+" },
	})[0]!;
	values.push(value);
}
const textIndex = builder.editor.appendStringConstants([[120]]);
builder.setTerminator(entry, { kind: "return", value });
const fn = program.function(builder.finish(entry).function);
const seedInstruction = coreInstructionId(fn.kernel.valueDefinitionOwner(seed));
const cfg = buildCoreControlFlow(program, fn.id);
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	const editor = CoreEditor.open(program, fn.id);
	if ((iteration & 1) === 0)
		editor.replaceInstruction(seedInstruction, "createNumber", [], {
			attributes: { value: iteration },
		});
	else
		editor.replaceInstruction(seedInstruction, "createString", [], {
			attributes: { stringIndex: textIndex },
		});
	editor.commit();
	const kinds = analyzeCoreValueKinds(program, fn, cfg);
	for (const current of values)
		checksum =
			(checksum +
				kinds.kindMask(current) +
				(kinds.exactScalar(current) === "int32" ? 1 : 0)) |
			0;
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
