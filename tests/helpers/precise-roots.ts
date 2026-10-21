import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";

/** Compiles with the shadow-frame roots that Wasm emission keeps. */
export function compilePreciseProgramImage(
	...args: Parameters<typeof compileSemanticProgramToProgramImage>
): ProgramImage {
	return lowerNativeStorage(compileSemanticProgramToProgramImage(...args), "precise");
}
