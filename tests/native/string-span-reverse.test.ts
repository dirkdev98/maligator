import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-reverse.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-span-reverse-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("substr and bounded reverse-search spans", () => {
	it("retains captured substr and lastIndexOf realms during coercing fallback", () => {
		const realmFixture = "tests/local/string-span-reverse-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};require(${JSON.stringify(path.resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `span-reverse-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60000,
					}),
				).toBe(expected);
		}
	}, 600000);

	it.each(["mutable", "locked"] as const)(
		"preserves relative bounds, reverse search, coercion and GC under %s primordials",
		(primordials) => {
			const env = { MAL_HOST_GC: "1", MAL_SPAN_MUTABLE: primordials };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-reverse-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const families = new Set<string>();
			let substr = false;
			for (const fn of pair.programImage.native.functions) {
				const plans = [
					...fn.specializations
						.filter((region) => region.kind === "string-span")
						.map((region) => ({
							producerIp: region.callIp,
							sourceKind: "range",
							rangeOperation: region.rangeOperation,
							consumers: region.consumers,
						})),
					...(fn.storage?.spanContinuations ?? []),
				];
				const children = new Set(
					plans.flatMap((plan) =>
						plan.consumers.filter((c) => c.kind === "rangeCall").map((c) => c.ip),
					),
				);
				for (const plan of plans) {
					if (plan.rangeOperation === "substr") substr = true;
					if (plan.consumers.some((c) => c.kind === "lastIndexOfCall"))
						families.add(children.has(plan.producerIp) ? "nested" : plan.sourceKind);
				}
			}
			expect(substr).toBe(true);
			expect([...families]).toEqual(
				expect.arrayContaining(["range", "split", "regexp", "nested"]),
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const methods = measured.stderr.match(
				/\[perf-string-span-reverse-stats\] substr=(\d+) last_index_of=(\d+)/,
			);
			expect(methods).not.toBeNull();
			for (const [index, method] of ["substr", "lastIndexOf"].entries())
				expect(Number(methods![index + 1]), `${method}: ${methods![0]}`).toBeGreaterThan(
					0,
				);
			const sources = measured.stderr.match(
				/\[perf-string-span-search-source-stats\] range=(\d+) split=(\d+) regexp=(\d+) nested=(\d+)/,
			);
			expect(sources).not.toBeNull();
			for (const [index, family] of ["range", "split", "regexp", "nested"].entries())
				expect(Number(sources![index + 1]), `${family}: ${sources![0]}`).toBeGreaterThan(
					0,
				);
			const materializations = measured.stderr.match(
				/\[perf-string-span-stats\] admissions=(\d+) projections=(\d+) materializations=(\d+)/,
			);
			expect(materializations).not.toBeNull();
			for (const count of materializations!.slice(1))
				expect(Number(count)).toBeGreaterThan(0);
		},
		600000,
	);
});
