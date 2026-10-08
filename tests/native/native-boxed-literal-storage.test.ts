import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("immutable boxed literal ABI", () => {
	const fixture = "tests/local/native-boxed-literal-storage.js";
	const config = resolveBuildConfig({ surface: { webPlatform: true } });
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-boxed-literals-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-boxed-literals-original",
			config,
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = pair.interpreted;
		const selected = new Set<string>();
		const image = lowerNativeStorage({
			...pair.programImage,
			native: {
				...pair.programImage.native,
				functions: pair.programImage.native.functions.map((fn) => {
					const name = String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					);
					if (!name.startsWith("boxed")) return fn;
					expect(fn.directEntries).toHaveLength(0);
					const literal = fn.body.instructions.find((op) =>
						[
							"CREATE_NUMBER",
							"CREATE_F64",
							"CREATE_BOOLEAN",
							"CREATE_NULL",
							"CREATE_UNDEFINED",
							"CREATE_BIGINT",
						].includes(op.opcode),
					);
					if (literal === undefined || !("dst" in literal))
						throw new Error("Missing boxed literal kernel");
					selected.add(name);
					return {
						...fn,
						registerRepresentations: fn.registerRepresentations.map((rep, local) =>
							local === literal.dst ? "boxed" : rep,
						),
					};
				}),
			},
		});
		expect(selected.size).toBe(11);
		for (const fn of image.native.functions) {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			);
			if (!selected.has(name)) continue;
			const ip = fn.body.instructions.findIndex((op) =>
				[
					"CREATE_NUMBER",
					"CREATE_F64",
					"CREATE_BOOLEAN",
					"CREATE_NULL",
					"CREATE_UNDEFINED",
					"CREATE_BIGINT",
				].includes(op.opcode),
			);
			const op = fn.body.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Missing boxed destination");
			expect(fn.registerRepresentations[op.dst]).toBe("boxed");
			expect(fn.storage!.rematerializedConstantIps).toContain(ip);
			expect(fn.storage!.rootRegisters).not.toContain(op.dst);
		}
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		compiled = buildNativeProgramImage(restored, {
			name: "native-boxed-literals-restored",
			config,
			mainFile: HOST_MAIN,
			outDir,
			compiled: true,
		});
	}, 600_000);

	it("preserves tags, signed zero, NaN, infinities, holes and BigInt errors across collection", () => {
		for (const binary of [compiled, interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binary, {
						env: { ...stress, MAL_HOST_GC: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
	});
});
