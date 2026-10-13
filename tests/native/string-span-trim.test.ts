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
const fixture = "tests/local/string-span-trim.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-span-trim-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("trim-derived string spans", () => {
	it("retains captured trim realms during boxed receiver coercion", () => {
		const realmFixture = "tests/local/string-span-trim-realms.js";
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
				name: `span-trim-realms-${compiled}`,
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
		"preserves bounded whitespace, parents, coercion and GC under %s primordials",
		(primordials) => {
			const env = { MAL_HOST_GC: "1", MAL_SPAN_MUTABLE: primordials };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-trim-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const methods = new Set<string>(),
				families = new Set<string>();
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
				for (const plan of plans)
					if (["trim", "trimStart", "trimEnd"].includes(plan.rangeOperation ?? "")) {
						methods.add(plan.rangeOperation!);
						const parent = plans.find((parent) =>
							parent.consumers.some(
								(consumer) =>
									consumer.kind === "rangeCall" && consumer.ip === plan.producerIp,
							),
						);
						families.add(parent?.sourceKind ?? "direct");
					}
			}
			expect([...methods]).toEqual(
				expect.arrayContaining(["trim", "trimStart", "trimEnd"]),
			);
			expect([...families]).toEqual(
				expect.arrayContaining(["direct", "range", "split", "regexp"]),
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
			for (const pattern of [
				/\[perf-string-span-trim-stats\] trim=(\d+) trim_start=(\d+) trim_end=(\d+)/,
				/\[perf-string-span-trim-source-stats\] direct=(\d+) range=(\d+) split=(\d+) regexp=(\d+)/,
			]) {
				const counts = measured.stderr.match(pattern);
				expect(counts).not.toBeNull();
				for (const count of counts!.slice(1)) expect(Number(count)).toBeGreaterThan(0);
			}
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
