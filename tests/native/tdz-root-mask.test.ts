import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/tdz-root-mask.js";

describe("native TDZ root-mask publication", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture,
			name: "tdz-root-mask",
			compiled: true,
		});
	}, 600_000);

	it("preserves initialized fast paths and throwing fallbacks", () => {
		assertExactLines(runToStdout(binary), ["tdz-root-mask PASS"]);
	});

	it("keeps fallback roots alive under GC stress", () => {
		assertExactLines(runToStdout(binary, { env: STRESS_ENV }), ["tdz-root-mask PASS"]);
	});
});
