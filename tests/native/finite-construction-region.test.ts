import { describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/finite-construction-region.js";

describe("finite construction regions", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves guarded construction semantics in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `finite-construction-region-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});

	it("keeps shape plans and dependency invalidation valid under GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "finite-construction-region-stress",
			compiled: true,
		});
		const output = runToStdout(binary, { env: STRESS_ENV });
		expect(output).toContain("RESULT 15/15");
	});

	it("keeps cached shapes rooted under concurrent verified GC", () => {
		const environment = {
			...process.env,
			MAL_GC_CONCURRENT: "1",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		};
		const binary = buildNativeBinary({
			fixture,
			name: "finite-construction-region-concurrent",
			compiled: true,
			environment,
		});
		const output = runToStdout(binary, { env: environment });
		expect(output).toContain("RESULT 15/15");
	});
});
