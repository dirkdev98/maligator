import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/guarded-rest-materialization.js";
const directory = mkdtempSync(path.join(tmpdir(), "mal-rest-materialization-"));
const splitPolicy = { thresholdCodeUnits: 1024, partCodeUnits: 1024 };
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("guarded captured rest arguments", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "rest-materialization",
			outDir: directory,
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, intl: { enabled: false }, temporal: false },
			}),
			nativeFunctionSplit: splitPolicy,
		});
	}, 600_000);
	for (const backend of ["compiled", "interpreted"] as const) {
		for (const stress of [false, true]) {
			it(`${backend} preserves argument snapshots, reentry, observers and throws${stress ? " under GC stress" : ""}`, () => {
				expect(
					runToStdout(pair[backend], {
						env: { MAL_HOST_GC: "1", ...(stress ? STRESS_ENV : {}) },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			});
		}
	}
	it("carries the deferred argument root lifetime through outlined C parts", () => {
		const { native, runtime } = pair.programImage;
		const fn = native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "guardedRest",
		)!;
		const emitted = emitCompiledFunction(
			fn,
			fn.functionIndex,
			"",
			false,
			"static",
			new Set(),
			native.semanticProtectors,
			new Map(),
			false,
			new Set(),
			runtime.stringConstants,
			new Set(),
			Infinity,
			splitPolicy,
		)!;
		expect(emitted.source).toContain("__argument_roots.count = 0");
		expect(emitted.source).toContain(`${emitted.symbol}_part_1(MalVm *vm`);
	});
});
