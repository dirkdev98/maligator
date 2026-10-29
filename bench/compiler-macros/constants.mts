import { readFileSync } from "node:fs";
import { deserializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { compactProgramImageConstants } from "../../src/compiler/target/program-image.ts";

const image = deserializeCompilerArtifact(readFileSync(process.argv[3]!));
const iterations = Number(process.argv[2] ?? 1);
let checksum = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
	const compacted = compactProgramImageConstants(image);
	if (!compacted.changed) throw new Error("constant replay did not compact its input");
	checksum = (checksum + compacted.definition.runtime.stringConstants.length) | 0;
	for (const fn of compacted.definition.native.functions)
		checksum = (checksum + fn.body.instructions.length) | 0;
}
console.log(
	JSON.stringify({ iterations, checksum, milliseconds: performance.now() - start }),
);
