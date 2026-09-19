import { emitProgramTranslationUnits } from "../../../src/compiler/target/emit-program-image.ts";
import { runRuntimeGapCase } from "../case-runner.mjs";
import {
	compilerEmitterFixtureFingerprint,
	compilerEmitterImage,
} from "../fixtures/compiler-emitter-image.mjs";

const MODULUS = 1_000_000_007;
const fingerprintSeed = Number.parseInt(
	compilerEmitterFixtureFingerprint.slice(0, 8),
	16,
);

function consumeSource(source, checksum) {
	for (let index = 0; index < source.length; index += 97) {
		checksum = (checksum * 33 + source.charCodeAt(index)) % MODULUS;
	}
	return (checksum + source.charCodeAt(source.length - 1)) % MODULUS;
}

function emitFragments(scale) {
	let checksum = fingerprintSeed;
	let operations = 0;
	for (let round = 0; round < scale; round++) {
		const units = emitProgramTranslationUnits(compilerEmitterImage, {
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
