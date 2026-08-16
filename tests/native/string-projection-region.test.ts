import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/string-projection-region.js";
const expected =
	"RESULT PASS 245,9,102,-12.5,16,Infinity,1,3,0,2,2,1,9,2,711,9,17,2,23 2 1";

describe("projected String producer-consumer regions", () => {
	it.each([true, false])("preserves generic fallbacks (compiled=%s)", (compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `string-projection-region-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toContain(expected);
	});

	it("keeps projected substrings rooted under verified GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "string-projection-region-stress",
			compiled: true,
		});
		expect(runToStdout(binary, { env: STRESS_ENV })).toContain(expected);
	});

	it("preserves projections under concurrent verified GC", () => {
		const environment = {
			...process.env,
			MAL_GC_CONCURRENT: "1",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		};
		const binary = buildNativeBinary({
			fixture,
			name: "string-projection-region-concurrent",
			compiled: true,
			environment,
		});
		expect(runToStdout(binary, { env: environment })).toContain(expected);
	});
});
