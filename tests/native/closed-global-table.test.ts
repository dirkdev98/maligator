import { describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/closed-global-table.js";

describe("closed global finite tables", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves table and materialization semantics in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `closed-global-table-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertPassLine(runToStdout(binary), "closed-global-table");
	});

	it("keeps synthetic global values rooted under verified GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "closed-global-table-stress",
			compiled: true,
		});
		assertPassLine(
			runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 }),
			"closed-global-table",
		);
	});

	it("keeps synthetic roots valid under concurrent collection", () => {
		const environment = {
			...process.env,
			MAL_GC_CONCURRENT: "1",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		};
		const binary = buildNativeBinary({
			fixture,
			name: "closed-global-table-concurrent",
			compiled: true,
			environment,
		});
		assertPassLine(
			runToStdout(binary, { env: environment, timeoutMs: 60_000 }),
			"closed-global-table",
		);
	});
});
