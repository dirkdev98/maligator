import { readFileSync } from "node:fs";
import { deserializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { compactProgramImageConstants } from "../../src/compiler/target/program-image.ts";

export function runConstantsMacro(iterations: number, imagePath: string) {
	const image = deserializeCompilerArtifact(readFileSync(imagePath));
	let checksum = 0;
	const start = performance.now();
	for (let iteration = 0; iteration < iterations; iteration++) {
		const compacted = compactProgramImageConstants(image);
		if (!compacted.changed) throw new Error("constant replay did not compact its input");
		checksum = (checksum + compacted.definition.runtime.stringConstants.length) | 0;
		for (const fn of compacted.definition.native.functions)
			checksum = (checksum + fn.body.instructions.length) | 0;
	}
	return { iterations, checksum, milliseconds: performance.now() - start };
}

if (import.meta.main)
	console.log(
		JSON.stringify(runConstantsMacro(Number(process.argv[2] ?? 1), process.argv[3]!)),
	);
