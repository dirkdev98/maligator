import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([false, true])(
	"preserves static-data coercion and effects with profiling %s",
	(profileEnabled) => {
		const fixture = "tests/local/static-data-query.mjs";
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const outDir = mkdtempSync(join(tmpdir(), "mal-static-query-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "static-query",
				profileEnabled,
				config: resolveBuildConfig({}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600000,
);

it("executes static queries across image growth during coercion", () => {
	const fixture = "tests/local/static-data-query-adoption.mjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-static-query-adoption-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "static-query-adoption",
			config: resolveBuildConfig({ engine: { eval: true } }),
			outDir,
		});
		const queries = pair.programImage.runtime.functions.flatMap((fn) =>
			fn.instructions.filter((instruction) => instruction.opcode === "QUERY_STATIC_DATA"),
		);
		expect(new Set(queries.map((query) => query.queryKind))).toEqual(
			new Set(["includes", "has-own"]),
		);
		for (const binary of [pair.compiled, pair.interpreted])
			expect(
				runToStdout(binary, {
					env: { MAL_HOST_GC: "1", MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
					timeoutMs: 60000,
				}),
			).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600000);
