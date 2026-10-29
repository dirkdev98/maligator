import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Config from "../src/build-config.ts";
import type * as Frontend from "../src/compiler/frontend/compact-type-strip.ts";
import type * as Core from "../src/compiler/pipeline/compile-core-common.ts";
import type * as Analysis from "../src/compiler/pipeline/compile-program-common.ts";
import type * as Pipeline from "../src/compiler/pipeline/compile-program.ts";
import type * as Artifact from "../src/compiler/target/compiler-artifact-codec.ts";
import type * as Emission from "../src/compiler/target/emit-program-image.ts";
import type * as Target from "../src/compiler/target/lower-core-target.ts";
import type * as Execution from "../src/compiler/target/lower-native-execution.ts";
import type * as Image from "../src/compiler/target/lower-native-program-image.ts";
import type * as Native from "../src/compiler/target/lower-native.ts";
import type * as Wire from "../src/compiler/target/program-image-codec.ts";
import type * as Harness from "../src/test-harness.ts";

const [mode, source, input, output, count = "1"] = process.argv.slice(2);
if (!source || !input || !output)
	throw new Error("expected MODE SOURCE INPUT OUTPUT [COUNT]");
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { resolveBuildConfig } = (await load("src/build-config.ts")) as typeof Config;
const { stripCompactTypes } = (await load(
	"src/compiler/frontend/compact-type-strip.ts",
)) as typeof Frontend;
const config = resolveBuildConfig({
	engine: { eval: false, realms: false, intl: { enabled: false } },
	surface: { node: true, webPlatform: false, maligator: false },
});
const options: Pipeline.CompileEntrypointOptions = {
	buildConfig: config,
	stripTypes: stripCompactTypes,
	coreInstrumentation: "off",
};
mkdirSync(output, { recursive: true });
if (mode === "capture") {
	const { analyzeEntrypoint } = (await load(
		"src/compiler/pipeline/compile-program-common.ts",
	)) as typeof Analysis;
	const { optimizeSemanticProgramToCore } = (await load(
		"src/compiler/pipeline/compile-core-common.ts",
	)) as typeof Core;
	const { lowerCoreCompilationToExecution } = (await load(
		"src/compiler/target/lower-native-execution.ts",
	)) as typeof Execution;
	const phase = <T>(_name: string, run: () => T) => run();
	const analysis = analyzeEntrypoint(input, options, phase);
	const optimized = optimizeSemanticProgramToCore(
		analysis.semantic,
		{ facts: analysis.facts, coreInstrumentation: "off" },
		phase,
	);
	const execution = lowerCoreCompilationToExecution(optimized);
	const captures = execution.functions
		.filter((fn) => fn.gc.safepoints.length > 0)
		.sort(
			(left, right) =>
				right.blocks.reduce((sum, block) => sum + block.instructions.length, 0) -
				left.blocks.reduce((sum, block) => sum + block.instructions.length, 0),
		)
		.slice(0, 24)
		.map((fn) => {
			const points = new Set(fn.gc.safepoints.map((point) => point.instruction));
			return {
				origin: {
					source: path.relative(source, fn.sourcePath),
					functionIndex: fn.functionIndex,
				},
				fn: {
					blocks: fn.blocks,
					registerCount: fn.registerCount,
					registerRepresentations: fn.registerRepresentations,
				},
				safepoints: fn.blocks.flatMap((block, b) =>
					block.instructions.flatMap((instruction, i) =>
						points.has(instruction) ? [[b, i]] : [],
					),
				),
			};
		});
	writeFileSync(path.join(output, "roots.json"), JSON.stringify(captures));
	console.log(
		JSON.stringify({
			functions: captures.length,
			instructions: captures.reduce(
				(sum, { fn }) => sum + fn.blocks.reduce((n, b) => n + b.instructions.length, 0),
				0,
			),
		}),
	);
} else if (mode === "lowering") {
	const { analyzeEntrypoint } = (await load(
		"src/compiler/pipeline/compile-program-common.ts",
	)) as typeof Analysis;
	const { optimizeSemanticProgramToCore } = (await load(
		"src/compiler/pipeline/compile-core-common.ts",
	)) as typeof Core;
	const target = (await load(
		"src/compiler/target/lower-core-target.ts",
	)) as typeof Target;
	const { lowerCoreCompilationToExecution } = (await load(
		"src/compiler/target/lower-native-execution.ts",
	)) as typeof Execution;
	const { lowerCoreCompilationToNativeProgram } = (await load(
		"src/compiler/target/lower-native.ts",
	)) as typeof Native;
	const { lowerExecutionToProgramImage } = (await load(
		"src/compiler/target/lower-native-program-image.ts",
	)) as typeof Image;
	const { serializeRuntimeImage } = (await load(
		"src/compiler/target/program-image-codec.ts",
	)) as typeof Wire;
	const { emitProgramTranslationUnits } = (await load(
		"src/compiler/target/emit-program-image.ts",
	)) as typeof Emission;
	const phase = <T>(_name: string, run: () => T) => run();
	const analysis = analyzeEntrypoint(input, options, phase);
	const optimized = optimizeSemanticProgramToCore(
		analysis.semantic,
		{ facts: analysis.facts, coreInstrumentation: "off" },
		phase,
	);
	const iterations = Number(count);
	let milliseconds = 0;
	let checksum = "";
	for (let iteration = 0; iteration < iterations; iteration++) {
		const start = performance.now();
		const preparation = target.prepareCoreCompilationToTargets?.(optimized);
		const execution = lowerCoreCompilationToExecution(optimized, { preparation });
		const native = lowerCoreCompilationToNativeProgram(optimized, { preparation });
		milliseconds += performance.now() - start;
		const image = lowerExecutionToProgramImage(execution, native);
		const digest = createHash("sha256").update(serializeRuntimeImage(image.runtime));
		for (const unit of emitProgramTranslationUnits(image))
			digest.update(unit.id).update(unit.source);
		const next = digest.digest("hex");
		if (checksum && checksum !== next)
			throw new Error("lowered C or runtime wire changed between iterations");
		checksum = next;
	}
	console.log(JSON.stringify({ iterations, checksum, milliseconds }));
} else {
	const { compileEntrypoint } = (await load(
		"src/compiler/pipeline/compile-program.ts",
	)) as typeof Pipeline;
	if (mode === "capture-image") {
		const { serializeCompilerArtifact } = (await load(
			"src/compiler/target/compiler-artifact-codec.ts",
		)) as typeof Artifact;
		const compiled = compileEntrypoint(input, options);
		const image = {
			...compiled,
			runtime: {
				...compiled.runtime,
				stringConstants: [...compiled.runtime.stringConstants, [0, 65535, 0]],
			},
		};
		writeFileSync(path.join(output, "image.malbc"), serializeCompilerArtifact(image));
		console.log(JSON.stringify({ functions: image.runtime.functions.length }));
	} else if (mode === "build") {
		const { buildNativeProgramImageResult } = (await load(
			"src/test-harness.ts",
		)) as typeof Harness;
		const image = compileEntrypoint(input, options);
		const result = buildNativeProgramImageResult(image, {
			name: path.basename(input, ".mts"),
			outDir: output,
			config,
			production: true,
		});
		const entries = image.native.functions.flatMap((fn) => fn.directEntries);
		const specializations: Record<string, number> = {};
		for (const fn of image.native.functions)
			for (const region of fn.specializations)
				specializations[region.kind] = (specializations[region.kind] ?? 0) + 1;
		const mechanisms = {
			toolchain: {
				tools: result.context.toolchain.tools,
				target: result.context.toolchain.target,
				rustTarget: result.context.toolchain.rustTarget,
				fingerprint: result.context.toolchain.fingerprint,
			},
			binaryBytes: statSync(result.binaryPath).size,
			plan: result.context.plan,
			features: result.context.features,
			binaryHash: createHash("sha256")
				.update(readFileSync(result.binaryPath))
				.digest("hex"),
			directEntries: image.native.functions.reduce(
				(sum, fn) => sum + fn.directEntries.length,
				0,
			),
			callbackTransports: image.native.functions.reduce(
				(sum, fn) => sum + fn.storage!.callbackTransports.length,
				0,
			),
			recordTransports: {
				resultEntries: entries.filter((entry) => entry.resultFields !== undefined).length,
				parameterEntries: entries.filter(
					(entry) => (entry.recordParameters?.length ?? 0) > 0,
				).length,
				resultAllocationSites: entries.reduce(
					(sum, entry) => sum + (entry.resultFields?.allocationIps.length ?? 0),
					0,
				),
			},
			specializations,
		};
		writeFileSync(
			path.join(output, "binary.json"),
			JSON.stringify({
				binary: result.binaryPath,
				functions: image.runtime.functions.length,
				...mechanisms,
			}),
		);
		console.log(
			JSON.stringify({
				binary: result.binaryPath,
				functions: image.runtime.functions.length,
				...mechanisms,
			}),
		);
	} else if (mode === "optimizer") {
		const { serializeRuntimeImage } = (await load(
			"src/compiler/target/program-image-codec.ts",
		)) as typeof Wire;
		let oracle = "";
		const iterations = Number(count),
			start = performance.now();
		for (let i = 0; i < iterations; i++) {
			const image = compileEntrypoint(input, options);
			const digest = createHash("sha256")
				.update(serializeRuntimeImage(image.runtime))
				.digest("hex");
			if (oracle && digest !== oracle)
				throw new Error("compiler output changed between iterations");
			oracle = digest;
		}
		console.log(
			JSON.stringify({
				iterations,
				checksum: oracle,
				milliseconds: performance.now() - start,
			}),
		);
	} else throw new Error(`unknown mode ${mode}`);
}
