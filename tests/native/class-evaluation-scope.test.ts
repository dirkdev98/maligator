import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/class-evaluation-scope.js";
const directory = mkdtempSync(join(tmpdir(), "mal-class-evaluation-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("keeps each class evaluation's identity across loops, exceptions and suspension", () => {
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "class-evaluation-scope",
		outDir: directory,
	});
	for (const [backend, binary] of [
		["compiled", pair.compiled],
		["interpreted", pair.interpreted],
	] as const) {
		for (const environment of [{}, STRESS_ENV])
			expect(runToStdout(binary, { env: environment, timeoutMs: 60_000 }), backend).toBe(
				expected,
			);
	}
}, 600_000);
