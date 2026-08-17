import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testSelectionRequiresLoopback } from "../scripts/test-environment.ts";

const loopbackTests = new Set(
	readFileSync("tests/test-suite-native-loopback.txt", "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#")),
);

describe("test environment capabilities", () => {
	it("preflights full native and listed loopback selections", () => {
		expect(testSelectionRequiresLoopback(["--project", "native"], loopbackTests)).toBe(
			true,
		);
		expect(
			testSelectionRequiresLoopback(
				["--project=native", "tests/native/node-http-listen.test.ts"],
				loopbackTests,
			),
		).toBe(true);
	});

	it("leaves unit, help, list, and non-loopback native selections alone", () => {
		expect(testSelectionRequiresLoopback(["--project", "unit"], loopbackTests)).toBe(
			false,
		);
		expect(
			testSelectionRequiresLoopback(
				["--project", "native", "tests/native/direct-known-call.test.ts"],
				loopbackTests,
			),
		).toBe(false);
		expect(
			testSelectionRequiresLoopback(["--project", "native", "--help"], loopbackTests),
		).toBe(false);
		expect(
			testSelectionRequiresLoopback(["list", "--project", "native"], loopbackTests),
		).toBe(false);
	});
});
