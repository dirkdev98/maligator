import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["module-loop-bindings PASS"];

describe("module-level loops in numeric regions", () => {
	let compiled: string;
	let interpreted: string;
	let slotted = 0;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/module-loop-bindings.mjs",
			name: "module-loop-bindings",
		});
		({ compiled, interpreted } = pair);
		slotted = pair.programImage.native.functions
			.flatMap((fn) => fn.storage?.numericLoopRegions ?? [])
			.filter((region) => (region.globals?.length ?? 0) > 0).length;
	}, 600_000);

	it("keeps the loops' module bindings in region locals", () => {
		expect(slotted).toBeGreaterThan(0);
	});

	it("matches the original loops through entry declines, restarts and exits", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("writes the bindings back when collection stress polls the loops out", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});
});
