import { describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("register allocation", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves loop-carried values in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/register_allocation.js",
			name: `register-allocation-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertPassLine(runToStdout(binary), "register-allocation");
	});
});
