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

const fixture = "tests/local/string-span-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-span-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("composable string spans", () => {
	it("retains captured character method realms during coercing fallback", () => {
		const realmFixture = "tests/local/string-span-code-points-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262 = { createRealm() { return { global: require("node:vm").runInNewContext("globalThis") }; } }; require(${JSON.stringify(path.resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `span-code-points-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
		}
	}, 600_000);
	it.each(["mutable", "locked"] as const)(
		"preserves projections, escaping branches, effects, and rooted sources under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_STRING_SPAN_MUTABLE: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `string-span-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions
					.flatMap((fn) => fn.specializations)
					.filter((region) => region.kind === "string-span").length,
			).toBeGreaterThan(0);
			expect(
				pair.programImage.native.functions.some((fn) =>
					fn.specializations.some(
						(region) =>
							region.kind === "string-span" && region.rangeOperation === "substring",
					),
				),
			).toBe(true);
			expect(
				pair.programImage.native.functions.some((fn) =>
					fn.specializations.some(
						(region) =>
							region.kind === "string-span" &&
							["length", "equal", "number"].every((kind) =>
								region.consumers.some((consumer) => consumer.kind === kind),
							),
					),
				),
			).toBe(true);
			const searchFamilies = new Set<string>();
			for (const fn of pair.programImage.native.functions) {
				const plans = [
					...fn.specializations
						.filter((region) => region.kind === "string-span")
						.map((region) => ({
							producerIp: region.callIp,
							sourceKind: "range",
							consumers: region.consumers,
						})),
					...(fn.storage?.spanContinuations ?? []),
				];
				const children = new Set(
					plans.flatMap((plan) =>
						plan.consumers
							.filter((consumer) => consumer.kind === "rangeCall")
							.map((consumer) => consumer.ip),
					),
				);
				for (const plan of plans)
					if (
						["indexOfCall", "includesCall", "startsWithCall", "endsWithCall"].every(
							(kind) => plan.consumers.some((consumer) => consumer.kind === kind),
						)
					)
						searchFamilies.add(
							children.has(plan.producerIp) ? "nested" : plan.sourceKind,
						);
			}
			expect([...searchFamilies]).toEqual(
				expect.arrayContaining(["range", "split", "regexp", "nested"]),
			);
			const nestedSources = pair.programImage.native.functions.flatMap(
				(fn) =>
					fn.storage?.spanContinuations
						.filter((plan) =>
							plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
						)
						.map((plan) => plan.sourceKind) ?? [],
			);
			expect(nestedSources).toEqual(expect.arrayContaining(["range", "split", "regexp"]));
			const deepSources = pair.programImage.native.functions.flatMap((fn) => {
				const depths = new Map(
					fn.specializations
						.filter((region) => region.kind === "string-span")
						.map((region) => [region.callIp, 1]),
				);
				const sources: Array<string> = [];
				for (const plan of fn.storage?.spanContinuations ?? []) {
					const depth =
						1 +
						Math.max(
							0,
							...plan.consumers
								.filter((consumer) => consumer.kind === "rangeCall")
								.map((consumer) => depths.get(consumer.ip) ?? 0),
						);
					depths.set(plan.producerIp, depth);
					if (depth === 4) sources.push(plan.sourceKind);
				}
				return sources;
			});
			expect(deepSources).toEqual(expect.arrayContaining(["range", "split", "regexp"]));
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_STRING_SPAN_MUTABLE: primordials, ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
					MAL_STRING_SPAN_MUTABLE: primordials,
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-string-span-stats\] admissions=(\d+) projections=(\d+) materializations=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			expect(Number(stats![2])).toBeGreaterThan(0);
			expect(Number(stats![3])).toBeGreaterThan(0);
			const characters = measured.stderr.match(
				/\[perf-string-span-character-stats\] reads=(\d+)/,
			);
			expect(characters).not.toBeNull();
			expect(Number(characters![1])).toBeGreaterThan(0);
			const stringCharacters = measured.stderr.match(
				/\[perf-string-span-string-character-stats\] char_at=(\d+) at=(\d+)/,
			);
			expect(stringCharacters).not.toBeNull();
			expect(Number(stringCharacters![1])).toBeGreaterThan(0);
			expect(Number(stringCharacters![2])).toBeGreaterThan(0);
			const codePoints = measured.stderr.match(
				/\[perf-string-span-code-point-stats\] reads=(\d+)/,
			);
			expect(codePoints).not.toBeNull();
			expect(Number(codePoints![1])).toBeGreaterThan(0);
			const nested = measured.stderr.match(
				/\[perf-string-span-nested-stats\] admissions=(\d+)/,
			);
			expect(nested).not.toBeNull();
			expect(Number(nested![1])).toBeGreaterThan(0);
			const deep = measured.stderr.match(
				/\[perf-string-span-deep-stats\] admissions=(\d+)/,
			);
			expect(deep).not.toBeNull();
			expect(Number(deep![1])).toBeGreaterThan(0);
			const searches = measured.stderr.match(
				/\[perf-string-span-search-stats\] index_of=(\d+) includes=(\d+) starts_with=(\d+) ends_with=(\d+)/,
			);
			expect(searches).not.toBeNull();
			for (const count of searches!.slice(1)) expect(Number(count)).toBeGreaterThan(0);
			const searchSources = measured.stderr.match(
				/\[perf-string-span-search-source-stats\] range=(\d+) split=(\d+) regexp=(\d+) nested=(\d+)/,
			);
			expect(searchSources).not.toBeNull();
			for (const [index, family] of ["range", "split", "regexp", "nested"].entries())
				expect(
					Number(searchSources![index + 1]),
					`${family}: ${searchSources![0]}`,
				).toBeGreaterThan(0);
			const substring = measured.stderr.match(
				/\[perf-string-span-substring-stats\] admissions=(\d+)/,
			);
			expect(substring).not.toBeNull();
			expect(Number(substring![1])).toBeGreaterThan(0);
		},
		600_000,
	);
});
