import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-dispatch-state.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-dispatch-state-"));
const hostGcEnv = { MAL_HOST_GC: "1" };

describe("localized interpreter dispatch state", () => {
	let expected: string;
	let binaries: Array<string>;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture,
				name: `interpreter-dispatch-state-${compiled ? "compiled" : "interpreted"}`,
				compiled,
				outDir,
			}),
		);
	}, 600_000);

	it("preserves leaf semantics, control flow, exceptions, reentry, and suspension", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: hostGcEnv, timeoutMs: 60_000 })).toBe(expected);
		}
	});

	it("keeps state canonical at GC-stress boundaries on both backends", () => {
		for (const binary of binaries) {
			expect(
				runToStdout(binary, {
					env: { ...hostGcEnv, ...STRESS_ENV },
					timeoutMs: 60_000,
				}),
			).toBe(expected);
		}
	});
});
