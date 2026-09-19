import { emitProgramTranslationUnits } from "../../../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../../../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../../../src/compiler/target/lower-native-program-image.ts";
import { runRuntimeGapCase } from "../case-runner.mjs";
import { compilerReplayCompilation } from "../compiler-replay-workload.mjs";

const MODULUS = 1_000_000_007;
const image = lowerExecutionToProgramImage(
	lowerCoreCompilationToExecution(compilerReplayCompilation, { reuseRegisters: true }),
	false,
);

function consumeSource(source, checksum) {
	for (let index = 0; index < source.length; index += 97) {
		checksum = (checksum * 33 + source.charCodeAt(index)) % MODULUS;
	}
	return (checksum + source.charCodeAt(source.length - 1)) % MODULUS;
}

function emitFragments(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < scale; round++) {
		const units = emitProgramTranslationUnits(image, {
			debugInfo: false,
			maligatorSurface: true,
		});
		for (const unit of units) {
			operations += unit.source.length;
			checksum = consumeSource(unit.source, checksum + unit.id.length);
		}
	}
	return { checksum, operations };
}

runRuntimeGapCase("c-emitter-fragments", emitFragments);
