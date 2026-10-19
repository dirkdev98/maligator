import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

const FIXTURE = "tests/local/node-legacy-exports/main.mjs";

for (const compiled of [true, false]) {
	describe(`legacy Node module exports (compiled=${compiled})`, () => {
		let outDir: string | undefined;
		let binary: string;
		beforeAll(() => {
			outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-legacy-exports-"));
			binary = buildNativeBinary({
				fixture: FIXTURE,
				name: `node-legacy-exports-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
		});
		afterAll(() => {
			if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
		});
		test(`url.resolve and url.resolveObject print what Node prints (compiled=${compiled})`, () => {
			const expected = execFileSync(process.execPath, ["--no-deprecation", FIXTURE], {
				encoding: "utf8",
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(60_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.split("\n")).toEqual(expected.split("\n"));
		}, 300_000);
	});
}
