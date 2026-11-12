import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-suspension-lifetimes-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/portable-suspension-lifetimes.mjs",
		name: "suspension-lifetimes",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"preserves live values across normal and throwing suspensions in %s code",
	(backend) => {
		for (const env of [{}, STRESS_ENV]) {
			expect(runToStdout(binaries[backend], { env })).toContain(
				"SUSPENSION LIFETIMES PASS",
			);
		}
	},
);

it("releases dead temporaries in a portable suspended frame", () => {
	const invocation = resolveHarnessExecutionInvocation(binaries.interpreted);
	const result = spawnSync(
		invocation.executable,
		[...invocation.args, "--check-collection"],
		{
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toContain("SUSPENSION LIFETIMES PASS");
});
