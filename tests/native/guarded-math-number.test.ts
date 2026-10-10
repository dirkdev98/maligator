import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves scalar Math coercion, errors and signed zeros through number guards", () => {
	const fixture = "tests/local/guarded-math-number.mjs";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-guarded-math-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "guarded-math-number",
			outDir,
			config: resolveBuildConfig({}),
		});
		expect(runToStdout(interpreted)).toBe(expected);
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);

it("runs patched and unpatched mutable Math callees through the callee guard", () => {
	const fixture = "tests/local/open-math-guard.mjs";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-open-math-guard-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "open-math-guard",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
		const index = programImage.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "round",
		);
		// The callee load answers its watched `Math.round` row inline.
		expect(
			emitCompiledFunction(programImage.native.functions[index]!, index, "", false)!
				.source,
		).toContain("mal_vm_watched_own_value_try_load_static(");
		expect(runToStdout(interpreted)).toBe(expected);
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);

it("preserves generic observations when a restored integer fusion takes either fallback", () => {
	const fixture = "tests/local/truncating-integer-fallback.mjs";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-integer-fallback-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const { programImage, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "integer-fallback-original",
			outDir,
		});
		expect(runToStdout(interpreted)).toBe(expected);
		let upgraded = 0;
		const image = {
			...programImage,
			native: {
				...programImage.native,
				functions: programImage.native.functions.map((fn) => ({
					...fn,
					specializations: fn.specializations.map((region) => {
						if (region.kind !== "numeric-fusion") return region;
						upgraded++;
						return {
							...region,
							representation: "binary-pairs-truncating-i32" as const,
							runtimeGuard: "int32-operands" as const,
						};
					}),
				})),
			},
		};
		expect(upgraded).toBeGreaterThan(0);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const compiled = buildNativeProgramImage(restored, {
			name: "integer-fallback-restored",
			outDir,
		});
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);
