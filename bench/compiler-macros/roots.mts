import { readFileSync } from "node:fs";
import type { CompilerInstruction } from "../../src/compiler/shared/compiler-instruction.ts";
import type { ExecutionFunction } from "../../src/compiler/target/execution-ir.ts";
import { executionSafepointRoots } from "../../src/compiler/target/execution-liveness.ts";

interface Capture {
	fn: ExecutionFunction;
	safepoints: Array<readonly [number, number]>;
}
const captures = (
	JSON.parse(readFileSync(process.argv[3]!, "utf8")) as Array<Capture>
).map(({ fn, safepoints }) => ({
	fn,
	safepoints: new Set(
		safepoints.map(([block, index]) => fn.blocks[block]!.instructions[index]!),
	),
}));
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const { fn, safepoints } of captures) {
		const roots = executionSafepointRoots(
			fn,
			safepoints as ReadonlySet<CompilerInstruction>,
		);
		for (const sets of roots.values()) {
			for (const list of [
				sets.rootRegisters,
				sets.incomingRootRegisters,
				sets.outgoingRootRegisters,
			]) {
				checksum = (Math.imul(checksum, 31) + list.length) | 0;
				for (const register of list) checksum = (Math.imul(checksum, 31) + register) | 0;
			}
		}
	}
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
