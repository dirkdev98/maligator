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

it.each(["mutable", "locked"] as const)(
	"preserves %s synchronous callback captures and lifetime fallbacks",
	(primordials) => {
		const fixture = "tests/local/synchronous-callback-captures.mjs";
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const outDir = mkdtempSync(join(tmpdir(), "mal-synchronous-callback-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "synchronous-callback",
				outDir,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false, intl: { enabled: false } },
				}),
			});
			const walk = pair.programImage.runtime.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === "walk",
			)!;
			expect(walk.instructions.some((op) => op.opcode === "CREATE_FUNCTION")).toBe(false);
			expect(walk.instructions.some((op) => op.opcode === "LOAD_CAPTURED")).toBe(false);
			expect(walk.capturedCount).toBe(0);
			expect(
				walk.instructions.some(
					(op) => op.opcode === "STORE_CAPTURED" || op.opcode === "CREATE_REST_ARGUMENTS",
				),
			).toBe(false);
			expect(
				walk.instructions.some(
					(op) => op.opcode === "CALL_REST_ARGUMENTS" && op.prefixArguments.length === 1,
				),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(
					expected,
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600_000,
);
