import { createHash } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { serializeCompilerArtifact } from "../src/compiler/target/compiler-artifact-codec.ts";
import { programImageStats } from "../src/compiler/target/program-image.ts";
import type {
	BuildCacheEvent,
	NativeBuildPhaseEvent,
} from "../src/native-build-context.ts";
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const CONFIG = resolveBuildConfig({
	engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
	surface: { node: true, webPlatform: false, maligator: true },
});

function required(args: ReadonlyArray<string>, option: string): string {
	const index = args.indexOf(option);
	const value = index < 0 ? undefined : args[index + 1];
	if (value === undefined) throw new Error(`missing ${option}`);
	return value;
}

function main(args: ReadonlyArray<string>): void {
	const fixture = path.resolve(required(args, "--fixture"));
	const output = path.resolve(required(args, "--output"));
	const name = required(args, "--name");
	const binaryDirectory = path.join(path.dirname(output), "runtime-gap-binaries");
	mkdirSync(binaryDirectory, { recursive: true });
	const frontend: Array<{ readonly cache: "hit" | "miss"; readonly entrypoint: string }> =
		[];
	const nativeCaches: Array<BuildCacheEvent> = [];
	const phases: Array<NativeBuildPhaseEvent> = [];
	const startedAt = performance.now();
	const result = buildNativeBinaryResult({
		fixture,
		name,
		config: CONFIG,
		production: true,
		outDir: binaryDirectory,
		environment: cleanTestEnvironment(),
		onFrontendCacheEvent: (event) => frontend.push(event),
		onNativeCacheEvent: (event) => nativeCaches.push(event),
		onNativeBuildPhase: (event) => phases.push(event),
	});
	const artifact = serializeCompilerArtifact(result.programImage, { debugInfo: false });
	const report = {
		schema: 1,
		binaryPath: result.binaryPath,
		buildMs: performance.now() - startedAt,
		executableBytes: statSync(result.binaryPath).size,
		compilerArtifactBytes: artifact.byteLength,
		compilerArtifactDigest: createHash("sha256").update(artifact).digest("hex"),
		programImage: programImageStats(result.programImage),
		frontend,
		nativeCaches,
		phases,
		measurements: result.measurements,
	};
	mkdirSync(path.dirname(output), { recursive: true });
	writeFileSync(`${output}.tmp`, `${JSON.stringify(report, undefined, "\t")}\n`);
	renameSync(`${output}.tmp`, output);
}

main(process.argv.slice(2));
