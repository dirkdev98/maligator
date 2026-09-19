import { lowerSemanticProgramToCore } from "../../src/compiler/core/core-frontend.ts";
import { optimizeCore } from "../../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";

function replayFunctionSource(index) {
	const width = 6 + (index & 7);
	return `
		function replay${index}(input, record) {
			let total = input + ${index};
			for (let cursor = 0; cursor < ${width}; cursor++) {
				const value = record.values[cursor & 7] ?? cursor;
				if (((value + total) & 1) === 0) total += value + record.offset;
				else total -= cursor;
			}
			try {
				if ((total & 31) === ${index & 31}) throw total;
			} catch (error) {
				total ^= error;
			}
			switch (total & 3) {
				case 0: total += record.left; break;
				case 1: total += record.right; break;
				case 2: total -= record.left; break;
				default: total -= record.right;
			}
			return total;
		}
	`;
}

function replaySource() {
	const functions = Array.from({ length: 72 }, (_, index) =>
		replayFunctionSource(index),
	).join("\n");
	const calls = Array.from(
		{ length: 72 },
		(_, index) => `replayTotal += replay${index}(${index}, replayRecord);`,
	).join("\n");
	return `${functions}
		const replayRecord = {
			values: [3, 5, 8, 13, 21, 34, 55, 89],
			offset: 7,
			left: 11,
			right: 17,
		};
		let replayTotal = 0;
		${calls}
		globalThis.replayTotal = replayTotal;
	`;
}

const constructed = lowerSemanticProgramToCore(
	analyzeSourceAndRunSemanticAnalysis(replaySource(), "runtime-gap-replay.js"),
);
export const compilerReplayCompilation = optimizeCore(constructed, {
	mode: "full",
}).compilation;

let instructionCount = 0;
for (const functionId of compilerReplayCompilation.program.functionIds()) {
	for (const _instruction of compilerReplayCompilation.program
		.function(functionId)
		.instructionIds()) {
		instructionCount++;
	}
}
export const compilerReplayInstructionCount = instructionCount;
