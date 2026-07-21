import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("fixed-width BigInt safety", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("defines bigint128 boundaries in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/bigint128-safety.js",
			name: `bigint128-safety-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});
});
