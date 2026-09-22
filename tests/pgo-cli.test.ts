import { expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.ts";
it("parses explicit training, profile use and merge inputs", () => {
	expect(
		parseCliArgs([
			"run",
			"app.mjs",
			"--pgo-train",
			"--pgo-workload",
			"representative",
			"--",
			"input.json",
		]),
	).toMatchObject({ kind: "run", pgoTrain: true, pgoWorkload: "representative" });
	expect(parseCliArgs(["build", "app.mjs", "--pgo-use", "profile.json"])).toMatchObject({
		kind: "build",
		pgoUse: "profile.json",
	});
	expect(
		parseCliArgs(["pgo", "merge", "run-a", "run-b", "--out", "profile.json"]),
	).toEqual({ kind: "pgo-merge", inputs: ["run-a", "run-b"], output: "profile.json" });
});
it.each([
	["run", "--pgo-train", "--pgo-use", "profile.json"],
	["run", "--pgo-workload", "without-training"],
	["run", "--pgo-train", "--profile"],
	["pgo", "merge"],
])("rejects incompatible or implicit PGO input: %s", (...args) => {
	expect(() => parseCliArgs(args)).toThrow();
});
