import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-callback-transport.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-callback-transport-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("typed builtin callback transport", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-callback-transport",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			mainFile: HOST_MAIN,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		const name = (index: number) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[
					image.native.functions[index]!.body.nameStringIndex
				] ?? []),
			);
		for (const [caller, target, contract] of [
			["runNumeric", "transform", { resultRepresentation: "number" }],
			["runCaptured", "captured", { resultRepresentation: "boxed" }],
			["runSnapshots", "snapshots", { argumentCount: 3 }],
			["runReceiver", "receiver", {}],
			["runReduce", "reducer", { argumentCount: 4 }],
			["runSigned", "signed", { resultRepresentation: "number" }],
		] as const) {
			const owner = image.native.functions.find(
				(fn) => name(fn.functionIndex) === caller,
			);
			expect(owner, caller).toBeDefined();
			const plan = owner!.storage!.callbackTransports.find(
				(plan) => name(plan.functionIndex) === target,
			);
			expect(plan, `${caller} -> ${target}`).toMatchObject(contract);
		}
	}, 600_000);

	it("preserves guard hits, coercing misses, captures, snapshots, nesting, and throws", () => {
		for (const binary of [compiled, interpreted]) {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, {
						env: { MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			}
		}
	});

	it("executes both typed callback hits and canonical fallback in the compiled product", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		expect(
			Number(result.stderr.match(/iteration_typed_callback_hits=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
		expect(
			Number(result.stderr.match(/iteration_typed_callback_fallbacks=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
	});
});
