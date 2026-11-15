import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "vitest";
import type { NativeBuildContext } from "../src/native-build-context.ts";
import {
	runIndependentCommands,
	runNativeCommand,
	runNativeCommands,
} from "../src/native-command.ts";

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

test.each([
	[1, 1],
	[1, 2],
	[2, 1],
	[2, 2],
])(
	"large output on descriptor %i does not interrupt queued commands with %i jobs",
	(fd, jobs) => {
		inDirectory((directory) => {
			runIndependentCommands(
				[
					{
						tool: process.execPath,
						args: [
							"-e",
							`require("node:fs").writeSync(${fd}, Buffer.alloc(2 * 1024 * 1024, "x"))`,
						],
					},
					shell(":"),
					shell("printf complete > completed"),
				],
				{ cwd: directory, env: emptyPath, jobs, verbose: false },
			);

			expect(readFileSync(path.join(directory, "completed"), "utf8")).toBe("complete");
		});
	},
);

test.each([1, 2])("large failure diagnostics preserve status with %i jobs", (jobs) => {
	const diagnostic = "diagnostic\n".repeat(128 * 1024);
	let failure: unknown;
	try {
		runIndependentCommands(
			[
				{
					tool: process.execPath,
					args: [
						"-e",
						'require("node:fs").writeSync(2, "diagnostic\\n".repeat(128 * 1024)); process.exit(7)',
					],
				},
				shell(":"),
			],
			{ env: emptyPath, jobs, verbose: false },
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ status: 7 });
	expect(failure).toHaveProperty("stderr", Buffer.from(diagnostic));
});

test.each([
	[1, false],
	[1, true],
	[2, false],
	[2, true],
] as const)(
	"verbose native batches with %i jobs preserve large stdout with resource measurement %s",
	(jobs, measureCommandResources) => {
		inDirectory((directory) => {
			const context = {
				cacheDirectory: directory,
				environment: { ...emptyPath, MAL_BUILD_JOBS: String(jobs) },
				measureCommandResources,
			} as unknown as NativeBuildContext;
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			try {
				const measurements = runNativeCommands(
					context,
					[
						{
							tool: process.execPath,
							args: [
								"-e",
								'require("node:fs").writeSync(1, Buffer.alloc(2 * 1024 * 1024, "x"))',
							],
						},
						shell(":"),
					],
					{ verbose: true },
				);
				expect(stderr).toHaveBeenCalledWith(Buffer.alloc(2 * 1024 * 1024, "x"));
				for (const measurement of measurements) {
					if (measureCommandResources)
						expect(measurement?.durationMs).toBeGreaterThanOrEqual(0);
					else expect(measurement).toBeUndefined();
				}
			} finally {
				stderr.mockRestore();
			}
		});
	},
);

test.each([1, 2])("one native command captures large output on descriptor %i", (fd) => {
	const context = { environment: emptyPath } as unknown as NativeBuildContext;
	expect(
		runNativeCommand(
			context,
			process.execPath,
			["-e", `require("node:fs").writeSync(${fd}, Buffer.alloc(2 * 1024 * 1024, "x"))`],
			{ verbose: false },
		),
	).toBeUndefined();
});

test("one native command retains large failure diagnostics and status", () => {
	const diagnostic = "diagnostic\n".repeat(128 * 1024);
	const context = { environment: emptyPath } as unknown as NativeBuildContext;
	let failure: unknown;
	try {
		runNativeCommand(
			context,
			process.execPath,
			[
				"-e",
				'require("node:fs").writeSync(2, "diagnostic\\n".repeat(128 * 1024)); process.exit(7)',
			],
			{ verbose: false },
		);
	} catch (error) {
		failure = error;
	}
	expect((failure as { status: number }).status).toBe(7);
	expect(failure).toHaveProperty("stderr", Buffer.from(diagnostic));
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
