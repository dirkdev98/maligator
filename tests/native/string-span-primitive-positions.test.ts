import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-primitive-positions.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-span-primitives-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("primitive positions in shared string spans", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves primitive conversion, fallback order, UTF16 and GC under %s primordials",
		(primordials) => {
			const env = { MAL_HOST_GC: "1", MAL_SPAN_MUTABLE: primordials };
			const oracle = (extra = {}) =>
				execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env, ...extra },
				});
			const expected = oracle();
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-primitives-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of [
				"primitiveSlice",
				"primitiveSubstring",
				"primitiveSubstr",
				"primitiveNested",
				"primitiveSplit",
				"primitiveCapture",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.specializations.some((region) => region.kind === "string-span") ||
						fn.storage!.spanContinuations.length > 0,
					name,
				).toBe(true);
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60000,
				env: {
					...process.env,
					...env,
					MAL_SPAN_PRIMITIVE_ONLY: "1",
					MAL_PERF_STATS: "1",
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(oracle({ MAL_SPAN_PRIMITIVE_ONLY: "1" }));
			for (const pattern of [
				/\[perf-string-span-character-stats\] reads=(\d+)/,
				/\[perf-string-span-string-character-stats\] char_at=(\d+) at=(\d+)/,
				/\[perf-string-span-code-point-stats\] reads=(\d+)/,
				/\[perf-string-span-search-stats\] index_of=(\d+) includes=(\d+) starts_with=(\d+) ends_with=(\d+)/,
				/\[perf-string-span-search-source-stats\] range=(\d+) split=(\d+) regexp=(\d+) nested=(\d+)/,
				/\[perf-string-span-substring-stats\] admissions=(\d+)/,
				/\[perf-string-span-reverse-stats\] substr=(\d+) last_index_of=(\d+)/,
			]) {
				const counts = measured.stderr.match(pattern);
				expect(counts, String(pattern)).not.toBeNull();
				for (const count of counts!.slice(1))
					expect(Number(count), counts![0]).toBeGreaterThan(0);
			}
		},
		600000,
	);
});
