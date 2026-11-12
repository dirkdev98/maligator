import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-async-stack-eval-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/async-stack-eval.mjs",
		name: "async-stack-eval",
		mainFile: HOST_MAIN,
		outDir,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"preserves awaiting callers after runtime compilation in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend])).toContain("ASYNC STACK EVAL PASS");
	},
);

it.each(["compiled", "interpreted"] as const)(
	"preserves awaiting callers under GC stress in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend], { env: STRESS_ENV })).toContain(
			"ASYNC STACK EVAL PASS",
		);
	},
);
