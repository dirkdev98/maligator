import { readFileSync } from "node:fs";
import { deserializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";

const image = deserializeCompilerArtifact(readFileSync(process.argv[3]!));
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	for (const unit of emitProgramTranslationUnits(image))
		checksum = (checksum + unit.source.length) | 0;
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
