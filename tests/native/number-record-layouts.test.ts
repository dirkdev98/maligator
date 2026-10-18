import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/number-record-layouts.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-number-layouts-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("numeric record storage across alternate shapes", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves slot identity through alternate shapes, generalization and fallback with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `number-layouts-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const selected = pair.programImage.native.functions
				.filter((fn) => fn.storage?.numberRecordRegions.length)
				.map((fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					),
				)
				.sort();
			expect(selected).toEqual(["total", "update"]);
			for (const mode of ["update", "grown", "readonly", "callable", "fallback"]) {
				const env = {
					NUMBER_LAYOUT_MODE: mode,
					MAL_PRIMORDIALS: primordials,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
				};
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
					timeout: 15000,
				});
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const invocation = resolveHarnessExecutionInvocation(target);
					const result = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, ...STRESS_ENV },
					});
					const context = `${primordials} ${backend} ${mode}`;
					expect(result.status, `${context}: ${result.stderr}`).toBe(0);
					expect(result.stdout, context).toBe(expected);
					if (backend === "compiled" && mode !== "fallback") {
						const stats = result.stderr.match(
							/\[perf-number-record\] attempts=\d+ admissions=(\d+) field_checks=\d+ poly_fields=(\d+) external=(\d+)/,
						);
						expect(stats, context).not.toBeNull();
						expect(Number(stats![1]), context).toBeGreaterThan(0);
						expect(Number(stats![2]), context).toBeGreaterThan(0);
						if (mode === "grown") expect(Number(stats![3]), context).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
	it("reads number record fields through polymorphic rows and shape snapshots", () => {
		const result = buildNativeBinaryResult({
			fixture,
			name: "number-record-field-contract",
			outDir,
			mainFile: "runtime/number_record_field_test_main.c",
			compiled: true,
		});
		expect(runToStdout(result.binaryPath).trim()).toBe("number-record-field PASS");
	}, 600000);
});
