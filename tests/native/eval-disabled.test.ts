import { mkdtempSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// The runtime half of `engine.eval: false` (the compile-time static check is
// covered by tests/build-config.test.ts). Builds the fixture into the eval-off
// archive (no compiler embed, -DMAL_EVAL=0); every dynamic-code path must throw
// EvalError at runtime, including the aliased indirect eval the static check can't
// see. The eval-off build selects its own content-addressed runtime artifacts.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-off-"));

describe("engine.eval: false runtime gate", () => {
	let evalOffBin: string;
	beforeAll(() => {
		evalOffBin = buildNativeBinary({
			fixture: "tests/local/eval_disabled.js",
			name: "eval-disabled",
			mainFile: HOST_MAIN,
			outDir,
			evalEnabled: false,
		});
	});

	it("eval / Function / aliased-eval all throw EvalError", () => {
		assertResultPass(runToStdout(evalOffBin));
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(evalOffBin, { env: STRESS_ENV }));
	});

	it("drops the baked compiler (smaller than the eval-on binary)", () => {
		const evalOnBin = buildNativeBinary({
			fixture: "tests/local/eval_disabled.js",
			name: "eval-enabled",
			mainFile: HOST_MAIN,
			outDir,
		});
		const offSize = statSync(evalOffBin).size;
		const onSize = statSync(evalOnBin).size;
		// Keep enough slack for linker differences without pinning the wire's exact size.
		expect(onSize - offSize).toBeGreaterThan(500_000);
	});
});
