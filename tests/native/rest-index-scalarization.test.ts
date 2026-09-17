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

it("scalarizes locked rest element reads without losing argument roots", () => {
	const fixture = "tests/local/rest-index-scalarization.js";
	const expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
	});
	const outDir = mkdtempSync(join(tmpdir(), "mal-rest-index-scalarization-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "rest-index-scalarization",
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
			outDir,
		});
		const instructions = pair.programImage.runtime.functions.flatMap(
			(fn) => fn.instructions,
		);
		expect(
			instructions.some((instruction) => instruction.opcode === "LOAD_ARGUMENT"),
		).toBe(true);
		expect(
			instructions.some((instruction) => instruction.opcode === "LOAD_ARGUMENT_COUNT"),
		).toBe(true);
		expect(
			instructions.some((instruction) => instruction.opcode === "CREATE_REST_ARGUMENTS"),
		).toBe(false);
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
