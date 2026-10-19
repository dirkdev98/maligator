import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-uncaught.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-uncaught-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("process uncaught exception and unhandled rejection handling", () => {
	let expected: string;
	let binaries: { compiled: string; interpreted: string };

	beforeAll(() => {
		expected = spawnSync(process.execPath, [fixture], { encoding: "utf8" }).stdout;
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-uncaught",
			nodeEnabled: true,
			mainFile: HOST_MAIN,
			outDir,
		});
	}, 600_000);

	it.each(["compiled", "interpreted"] as const)(
		"matches Node and exits 1 when %s",
		(variant) => {
			const invocation = resolveHarnessExecutionInvocation(binaries[variant]);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(result.stdout).toBe(expected);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("fatal");
		},
	);
});
