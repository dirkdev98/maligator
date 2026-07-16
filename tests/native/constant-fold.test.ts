import { describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("primitive constant folding", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves runtime semantics in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/constant_fold.js",
			name: `constant-fold-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertPassLine(runToStdout(binary), "constant-fold");
	});
});
