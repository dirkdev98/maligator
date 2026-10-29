import { readFileSync } from "node:fs";
import type { ExecutionFunction } from "../../src/compiler/target/execution-ir.ts";
import { nativeLoopBackedgeInstructions } from "../../src/compiler/target/execution-liveness.ts";

const functions = (
	JSON.parse(readFileSync(process.argv[3]!, "utf8")) as Array<{ fn: ExecutionFunction }>
).map(({ fn }) => {
	const ids = new Map(
		fn.blocks
			.flatMap((block) => block.instructions)
			.map((instruction, index) => [instruction, index]),
	);
	return { fn, ids };
});
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const { fn, ids } of functions) {
		const backedges = nativeLoopBackedgeInstructions(fn);
		checksum = (Math.imul(checksum, 31) + backedges.size) | 0;
		for (const instruction of backedges)
			checksum = (Math.imul(checksum, 31) + ids.get(instruction)!) | 0;
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
