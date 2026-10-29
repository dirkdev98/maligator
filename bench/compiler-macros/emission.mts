import { readFileSync } from "node:fs";
import { deserializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";

export function runEmissionMacro(iterations: number, imagePath: string) {
	const image = deserializeCompilerArtifact(readFileSync(imagePath));
	let checksum = 0;
	const start = performance.now();
	for (let iteration = 0; iteration < iterations; iteration++) {
		for (const unit of emitProgramTranslationUnits(image))
			checksum = (checksum + unit.source.length) | 0;
	}
	return { iterations, checksum, milliseconds: performance.now() - start };
}

if (import.meta.main)
	console.log(
		JSON.stringify(runEmissionMacro(Number(process.argv[2] ?? 1), process.argv[3]!)),
	);
