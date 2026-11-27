import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

it("matches Node's declaration binding behavior in a sloppy script", () => {
	const fixture = "tests/local/function-declaration-scopes.js";
	const expected = execFileSync(
		process.execPath,
		[
			"-e",
			'require("node:vm").runInThisContext(require("node:fs").readFileSync(process.argv[1], "utf8"))',
			fixture,
		],
		{ encoding: "utf8" },
	);
	const outDir = mkdtempSync(join(tmpdir(), "mal-function-declarations-"));
	try {
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "function-declaration-scopes",
			entryGoal: "script",
			entryStrict: false,
			config: preparedNativeEvalConfig(),
			outDir,
		});
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
