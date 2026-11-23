import * as path from "node:path";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { compileEntrypointToBuffer } from "./compiler/pipeline/compile-runtime-program.ts";
import { embeddedCompilerOptions } from "./compiler/pipeline/embedded-compiler-options.ts";

export function portableEvalCompilerBake(sourceDirectory: string): CompilerBakeInput {
	const entrypoint = path.join(
		sourceDirectory,
		"compiler/pipeline/eval-compiler-entry.mts",
	);
	return {
		kind: "source",
		sourceDirectory,
		entrypoint,
		producer: path.join(sourceDirectory, "portable-compiler-bake.ts"),
		bake: () =>
			compileEntrypointToBuffer(entrypoint, {
				...embeddedCompilerOptions(sourceDirectory),
				stripTypes: stripCompactTypes,
			}),
	};
}
