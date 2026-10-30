import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lowerSemanticProgramToCore } from "../../src/compiler/core/core-frontend.ts";
import { optimizeCore } from "../../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { prepareCoreCompilationToTargets } from "../../src/compiler/target/lower-core-target.ts";
import { lowerCoreCompilationToExecution } from "../../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../../src/compiler/target/lower-native-program-image.ts";
import { lowerCoreCompilationToNativeProgram } from "../../src/compiler/target/lower-native.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";

const source = readFileSync(process.argv[3]!, "utf8");
const semantic = analyzeSourceAndRunSemanticAnalysis(
	source,
	"/compiler-liveness-extraction.js",
);
const core = optimizeCore(lowerSemanticProgramToCore(semantic)).compilation;
const iterations = Number(process.argv[2] ?? 1);
let milliseconds = 0;
let checksum = "";
for (let iteration = 0; iteration < iterations; iteration++) {
	const start = performance.now();
	const preparation = prepareCoreCompilationToTargets(core);
	const execution = lowerCoreCompilationToExecution(core, { preparation });
	const native = lowerCoreCompilationToNativeProgram(core, { preparation });
	milliseconds += performance.now() - start;
	const image = lowerExecutionToProgramImage(execution, native);
	const digest = createHash("sha256").update(serializeRuntimeImage(image.runtime));
	for (const unit of emitProgramTranslationUnits(image)) {
		digest.update(unit.id);
		for (const chunk of unit.sourceChunks) digest.update(chunk);
	}
	const next = digest.digest("hex");
	if (checksum && checksum !== next)
		throw new Error("lowered output changed between iterations");
	checksum = next;
}
console.log(JSON.stringify({ iterations, checksum, milliseconds }));
