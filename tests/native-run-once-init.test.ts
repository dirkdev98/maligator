import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";

it("marks module evaluation and confined initialization calls eligible for size emission", () => {
	const image = compileEntrypoint("tests/local/native-run-once-init.mjs", {
		buildConfig: resolveBuildConfig({}),
		coreOptimizationBenchmarkAblation: { family: "inlining-cross-call" },
	});
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
	const names = restored.native.functions
		.filter((fn) => fn.runOnce === true)
		.map((fn) =>
			String.fromCharCode(
				...(restored.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			),
		);
	expect(names.filter(Boolean).sort()).toEqual(["initialize", "makeState"]);
	expect(
		restored.native.functions.some(
			(fn) => fn.runOnce === true && fn.body.handlers.length > 0,
		),
	).toBe(true);
});
