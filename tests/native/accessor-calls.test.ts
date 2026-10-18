import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/accessor-calls.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-accessor-calls-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("class accessor calls", () => {
	it("probe for the hinted accessor and keep ordinary semantics for every other receiver", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "accessor-calls",
			outDir,
		});
		const probes = new Set<string>();
		for (const fn of pair.programImage.native.functions)
			for (const instruction of fn.body.instructions)
				if (instruction.opcode === "PROBE_READ") probes.add(instruction.readKind);
		expect(probes.has("getter")).toBe(true);
		expect(probes.has("setter")).toBe(true);
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	}, 600000);
});
