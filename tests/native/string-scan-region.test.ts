import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/string-scan-region.js";

describe("inlined String scan summaries", () => {
	it("removes a closed aggregate graph and falls back after epoch invalidation", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "string-scan-region-compiled",
			compiled: true,
		});
		expect(runToStdout(binary)).toContain("RESULT PASS 58890 58890 46890");
	});

	it("keeps the summarized input rooted under verified GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "string-scan-region-stress",
			compiled: true,
		});
		expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
			"RESULT PASS 58890 58890 46890",
		);
	});

	it("keeps the flat UTF-16 view stable under concurrent verified GC", () => {
		const environment = {
			...process.env,
			MAL_GC_CONCURRENT: "1",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		};
		const binary = buildNativeBinary({
			fixture,
			name: "string-scan-region-concurrent",
			compiled: true,
			environment,
		});
		expect(runToStdout(binary, { env: environment })).toContain(
			"RESULT PASS 58890 58890 46890",
		);
	});
});
