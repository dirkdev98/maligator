import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";

const program = new CoreProgram(coreOpcodeRegistry);
for (let functionIndex = 0; functionIndex < 12; functionIndex++) {
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const header = builder.createBlock([
		{ representation: "boxed" },
		{ representation: "boxed" },
	]);
	const exit = builder.createBlock();
	const first = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: functionIndex },
	})[0]!;
	const second = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: functionIndex + 1 },
	})[0]!;
	const condition = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	})[0]!;
	builder.setTerminator(entry, {
		kind: "jump",
		edge: { block: header, arguments: [first, functionIndex % 2 === 0 ? first : second] },
	});
	let left = builder.blockParameterValue(header, 0);
	let right = builder.blockParameterValue(header, 1);
	for (let index = 0; index < 192; index++) {
		left = builder.appendInstruction(header, "move", [left])[0]!;
		right = builder.appendInstruction(header, "move", [right])[0]!;
	}
	builder.setTerminator(header, {
		kind: "branch",
		condition,
		consequent: { block: header, arguments: [right, left] },
		alternate: { block: exit, arguments: [] },
	});
	builder.setTerminator(exit, { kind: "return", value: left });
	builder.finish(entry);
}
const functions = [...program.functionIds()].map((id) => ({
	fn: program.function(id),
	cfg: buildCoreControlFlow(program, id),
}));
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const { fn, cfg } of functions) {
		const roots = coreCanonicalValueRoots(fn, cfg);
		for (const [value, root] of roots)
			checksum = (Math.imul(checksum, 31) + value + root) | 0;
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
