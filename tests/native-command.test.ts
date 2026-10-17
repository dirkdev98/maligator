import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { runIndependentCommands } from "../src/native-command.ts";

function shell(script: string) {
	return { tool: "/bin/sh", args: ["-c", script] };
}

/** What isolated native build checks leave on PATH for the scheduler itself. */
const emptyPath = { PATH: "" };

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
				`i=0; while [ ! -e marker ]; do i=$((i + 1)); [ "$i" -gt 1000 ] && exit 1; /bin/sleep 0.01; done`,
			),
			shell(":"),
			shell(": > marker"),
		];

		expect(() =>
			runIndependentCommands(commands, {
				cwd: directory,
				env: emptyPath,
				jobs: 2,
				verbose: false,
			}),
		).not.toThrow();
	});
});

test("a failing command fails the batch with its exit status", () => {
	inDirectory((directory) => {
		const commands = [shell(":"), shell("exit 3"), shell(":")];

		expect(() =>
			runIndependentCommands(commands, {
				cwd: directory,
				env: emptyPath,
				jobs: 2,
				verbose: false,
			}),
		).toThrow(expect.objectContaining({ status: 3 }));
	});
});

test("runs every command once with nothing but the commands on PATH", () => {
	inDirectory((directory) => {
		const commands = Array.from({ length: 12 }, (_, index) =>
			shell(`set -C; : > ran-${index}`),
		);

		runIndependentCommands(commands, {
			cwd: directory,
			env: emptyPath,
			jobs: 4,
			verbose: false,
		});

		expect(readdirSync(directory).sort()).toEqual(
			Array.from({ length: 12 }, (_, index) => `ran-${index}`).sort(),
		);
	});
});
