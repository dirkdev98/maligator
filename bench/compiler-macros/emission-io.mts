import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deserializeCompilerArtifact } from "../../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { writeSourceChunks } from "../../src/generated-source.ts";

export function runEmissionIoMacro(iterations: number, imagePath: string) {
	const image = deserializeCompilerArtifact(readFileSync(imagePath));
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-emission-io-"));
	let checksum = "";
	const start = performance.now();
	try {
		for (let iteration = 0; iteration < iterations; iteration++) {
			const digest = createHash("sha256");
			for (const unit of emitProgramTranslationUnits(image)) {
				const compatible: { source?: string; sourceChunks?: ReadonlyArray<string> } =
					unit;
				const file = path.join(directory, `${unit.id}.c`);
				digest.update(unit.id);
				if (compatible.sourceChunks === undefined) {
					const bytes = Buffer.from(compatible.source!);
					digest.update(bytes);
					writeFileSync(file, bytes);
				} else writeSourceChunks(file, compatible.sourceChunks, digest);
			}
			const next = digest.digest("hex");
			if (checksum && checksum !== next)
				throw new Error("emitted bytes changed between iterations");
			checksum = next;
		}
		return { iterations, checksum, milliseconds: performance.now() - start };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (import.meta.main)
	console.log(
		JSON.stringify(runEmissionIoMacro(Number(process.argv[2] ?? 1), process.argv[3]!)),
	);
