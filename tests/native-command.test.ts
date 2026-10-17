import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { runIndependentCommands } from "../src/native-command.ts";

function shell(script: string) {
	return { tool: "/bin/sh", args: ["-c", script] };
}

function inDirectory(run: (directory: string) => void): void {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-native-command-"));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

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

test("starts a queued command in whichever slot frees first", () => {
	inDirectory((directory) => {
		// The first command holds its slot until the third one runs, so the third
		// has to start in the slot the second one frees.
		const commands = [
			shell(
				`i=0; while [ ! -e marker ]; do i=$((i + 1)); [ "$i" -gt 1000 ] && exit 1; sleep 0.01; done`,
			),
			shell(":"),
			shell("touch marker"),
		];

		expect(() =>
			runIndependentCommands(commands, { cwd: directory, jobs: 2, verbose: false }),
		).not.toThrow();
	});
});

test("a failing command fails the batch with its exit status", () => {
	inDirectory((directory) => {
		const commands = [shell(":"), shell("exit 3"), shell(":")];

		expect(() =>
			runIndependentCommands(commands, { cwd: directory, jobs: 2, verbose: false }),
		).toThrow(expect.objectContaining({ status: 3 }));
	});
});
