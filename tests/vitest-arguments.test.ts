import { describe, expect, it } from "vitest";
import { constrainVitestMaxWorkers } from "../scripts/vitest-arguments.ts";

describe("Vitest worker arguments", () => {
	it("replaces either maxWorkers form with the allocated count", () => {
		expect(
			constrainVitestMaxWorkers(
				["run", "--maxWorkers=4", "--project", "native", "--maxWorkers", "3"],
				2,
			),
		).toEqual(["run", "--project", "native", "--maxWorkers=2"]);
	});

	it("rejects a maxWorkers flag without its value", () => {
		expect(() => constrainVitestMaxWorkers(["run", "--maxWorkers"], 2)).toThrow(
			"--maxWorkers requires a value",
		);
	});
});
