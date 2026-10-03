import { expect, test } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

test("module evaluation shares initialization, async dependencies, cycles and failures in native and wire execution", () => {
	const pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/module-evaluation/entry.mjs",
		name: "module-evaluation",
		mainFile: HOST_MAIN,
	});
	for (const executable of [pair.compiled, pair.interpreted]) {
		const result = runToStdout(executable);
		assertResultPass(result);
		expect(result).toContain("RESULT 16/16");
	}
}, 300_000);

test.each(["ancestor-order", "sync-self", "deferred-entry", "for-await-entry"])(
	"%s preserves module evaluation ordering in both backends",
	(fixture) => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: `tests/local/module-evaluation/${fixture}.mjs`,
			name: `module-evaluation-${fixture}`,
			mainFile: HOST_MAIN,
		});
		for (const executable of [pair.compiled, pair.interpreted]) {
			const result = runToStdout(executable);
			assertResultPass(result);
			expect(result).toContain("RESULT 1/1");
		}
	},
	300_000,
);

test("a rejecting async dependency propagates while an earlier sibling remains pending", () => {
	const pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/module-evaluation/rejection-order.mjs",
		name: "module-evaluation-rejection-order",
		mainFile: HOST_MAIN,
	});
	for (const executable of [pair.compiled, pair.interpreted]) {
		const result = runToStdout(executable);
		assertResultPass(result);
		expect(result).toContain("RESULT 1/1");
	}
}, 300_000);
