import { lowerCoreCompilationToExecution } from "../../../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../../../src/compiler/target/lower-native-program-image.ts";
import { programImageStats } from "../../../src/compiler/target/program-image.ts";
import { runRuntimeGapCase } from "../case-runner.mjs";
import {
	compilerReplayCompilation,
	compilerReplayInstructionCount,
} from "../compiler-replay-workload.mjs";

const MODULUS = 1_000_000_007;

function loweringReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < scale; round++) {
		const execution = lowerCoreCompilationToExecution(compilerReplayCompilation, {
			reuseRegisters: true,
		});
		const image = lowerExecutionToProgramImage(execution, false);
		const stats = programImageStats(image);
		checksum =
			(checksum +
				stats.functionCount * 31 +
				stats.instructionCount * 17 +
				image.runtime.stringConstants.length) %
			MODULUS;
		for (const fn of image.runtime.functions) {
			checksum =
				(checksum + fn.registerCount + fn.handlers.length + fn.instructions.length) %
				MODULUS;
		}
		operations += compilerReplayInstructionCount;
	}
	return { checksum, operations };
}

runRuntimeGapCase("core-lowering-replay", loweringReplay);
