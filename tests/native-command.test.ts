import { expect, test } from "vitest";
import { runIndependentCommands } from "../src/native-command.ts";

test("large parallel command batches are not passed through one argv entry", () => {
	const argument = "x".repeat(1024);
	const commands = Array.from({ length: 2048 }, () => ({
		tool: ":",
		args: [argument],
	}));

	expect(() =>
		runIndependentCommands(commands, { jobs: 8, verbose: false }),
	).not.toThrow();
});
