import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("executes the outlined setup once whether the module loop runs or skips", () => {
	const fixture = "tests/local/native-run-once-loop.mjs";
	const outDir = mkdtempSync(join(tmpdir(), "mal-run-once-init-"));
	try {
		const binary = buildNativeBinary({
			fixture,
			name: "run-once-init",
			outDir,
			mainFile: HOST_MAIN,
			production: true,
		});
		const invocation = resolveHarnessExecutionInvocation(binary);
		for (const count of ["0", "8"]) {
			const expected = execFileSync(process.execPath, [fixture, count], {
				encoding: "utf8",
			});
			expect(
				execFileSync(invocation.executable, [...invocation.args, count], {
					encoding: "utf8",
					env: { ...process.env, ...STRESS_ENV },
				}),
			).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
