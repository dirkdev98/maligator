import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const root = mkdtempSync(path.join(tmpdir(), "mal-maligator-fs-"));
let runs = 0;
let pair: BackendPairResult;

beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/maligator-fs.mjs",
		name: "maligator-fs",
		outDir: path.join(root, "out"),
	});
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh working directory holding the entries the permission cases need. */
function workingDirectory(): string {
	const directory = path.join(root, `run-${runs++}`);
	mkdirSync(path.join(directory, "locked"), { recursive: true });
	chmodSync(path.join(directory, "locked"), 0o555);
	writeFileSync(path.join(directory, "unreadable.txt"), "secret");
	chmodSync(path.join(directory, "unreadable.txt"), 0o000);
	mkdirSync(path.join(directory, "outside"));
	writeFileSync(path.join(directory, "outside/kept.txt"), "outside");
	mkdirSync(path.join(directory, "listing"));
	symlinkSync("../outside", path.join(directory, "listing/link"), "dir");
	symlinkSync("missing.txt", path.join(directory, "listing/dangling"));
	execFileSync("mkfifo", [path.join(directory, "listing/pipe")]);
	return directory;
}

function tree(directory: string): Array<string> {
	return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
}

/** Node's output and final tree for the scenario, in a fresh working directory. */
function reference(): { stdout: string; tree: Array<string> } {
	const cwd = workingDirectory();
	const stdout = execFileSync(
		process.execPath,
		[path.resolve("tests/local/maligator-fs-node.mjs")],
		{ cwd, encoding: "utf8" },
	);
	return { stdout, tree: tree(cwd) };
}

function expectScenario(
	binary: string,
	expected: { stdout: string; tree: Array<string> },
	env: NodeJS.ProcessEnv = {},
): void {
	const cwd = workingDirectory();
	expect(runToStdout(binary, { cwd, env })).toBe(expected.stdout);
	// Atomic writes leave no temporary file behind, after success or failure.
	expect(tree(cwd)).toEqual(expected.tree);
}

it("matches Node's fs/promises for file and directory operations", () => {
	const expected = reference();
	expect(expected.stdout).toContain("url /tmp/a b.txt");
	if (process.getuid?.() !== 0) {
		expect(expected.stdout).toContain(
			"locked write FileSystemError true EACCES open locked/new.txt",
		);
	}
	for (const binary of [pair.compiled, pair.interpreted]) {
		for (const env of [{}, STRESS_ENV]) expectScenario(binary, expected, env);
	}
});

const streamInput = Buffer.from([0, 1, 2, 254, 255, 10, 123, 128, 99]);
const backends = (pair: BackendPairResult) => [pair.compiled, pair.interpreted];

function incrementalDirectory(name: string, input?: Buffer): string {
	const cwd = path.join(root, `run-${runs++}`);
	mkdirSync(cwd);
	writeFileSync(path.join(cwd, ".incremental"), name);
	if (input !== undefined) writeFileSync(path.join(cwd, "input.bin"), input);
	return cwd;
}

function incrementalReference(name: string, input?: Buffer): string {
	return execFileSync(
		process.execPath,
		[path.resolve("tests/local/maligator-fs-incremental-node.mjs"), name],
		{ cwd: incrementalDirectory(name, input), encoding: "utf8", timeout: 15000 },
	);
}

it("streams the same bytes as Node's web and filesystem read streams", () => {
	const expected = incrementalReference("read", streamInput);
	for (const binary of backends(pair)) {
		for (const env of [{}, STRESS_ENV]) {
			expect(
				runToStdout(binary, { cwd: incrementalDirectory("read", streamInput), env }),
			).toBe(expected);
		}
	}
});

it("releases descriptors after cancelling a reader, including while it opens", () => {
	for (const binary of backends(pair)) {
		const { executable, args } = resolveHarnessExecutionInvocation(binary);
		for (const env of [{}, STRESS_ENV]) {
			const stdout = execFileSync(
				"/bin/sh",
				["-c", 'ulimit -n 32; exec "$@"', "cancel", executable, ...args],
				{
					cwd: incrementalDirectory("cancel", streamInput),
					encoding: "utf8",
					env: { ...process.env, ...env },
					timeout: scaledNativeRunTimeoutMs(20000, { ...process.env, ...env }),
				},
			);
			const chunk = JSON.parse(stdout) as Array<number>;
			expect(chunk.length).toBeGreaterThan(0);
			expect(chunk.length).toBeLessThanOrEqual(3);
			expect(chunk).toEqual([...streamInput.subarray(0, chunk.length)]);
		}
	}
});

function memoryRun(binary: string, input: Buffer): { peak: number; output: unknown } {
	const { executable, args } = resolveHarnessExecutionInvocation(binary);
	const darwin = process.platform === "darwin";
	const cwd = incrementalDirectory("size", input);
	const report = path.join(cwd, "rss.txt");
	const result = spawnSync(
		"/usr/bin/time",
		[...(darwin ? ["-l"] : ["-f", "%M", "-o", report]), executable, ...args],
		{ cwd, encoding: "utf8", timeout: scaledNativeRunTimeoutMs(20000) },
	);
	if (result.status !== 0 || result.error !== undefined)
		throw new Error(
			`Stream process failed: ${result.error ?? result.stderr ?? result.signal}`,
		);
	const measurement = darwin
		? /^\s*(\d+)\s+maximum resident set size/m.exec(result.stderr)?.[1]
		: readFileSync(report, "utf8").trim();
	const peak = Number(measurement) * (darwin ? 1 : 1024);
	if (!Number.isFinite(peak) || peak <= 0)
		throw new Error("Missing peak RSS measurement");
	return { peak, output: JSON.parse(result.stdout) };
}

it("streams a 16 MiB file with bounded peak resident memory", () => {
	const input = Buffer.alloc(16 * 1024 * 1024, 7);
	const controlInput = input.subarray(0, 1);
	const expected = { length: input.length, checksum: 7 * input.length };
	for (const binary of backends(pair)) {
		if (process.env.MAL_ASAN === "1" || process.env.MAL_TSAN === "1") {
			// Instrumented allocators retain freed stores and change the RSS baseline.
			const stdout = runToStdout(binary, { cwd: incrementalDirectory("size", input) });
			expect(JSON.parse(stdout)).toEqual(expected);
			continue;
		}
		// Process residency varies between runs, so use the median of paired measurements.
		const growth = Array.from({ length: 3 }, () => {
			const control = memoryRun(binary, controlInput);
			const streamed = memoryRun(binary, input);
			expect(streamed.output).toEqual(expected);
			return streamed.peak - control.peak;
		});
		expect(
			growth.toSorted((left, right) => left - right)[1],
			`RSS grew by ${growth.join(", ")} bytes across the three control/stream pairs`,
		).toBeLessThan(input.length / 2);
	}
});

it("orders writer operations on an open descriptor and appends after reopening", () => {
	const expected = incrementalReference("writer");
	for (const binary of backends(pair)) {
		for (const env of [{}, STRESS_ENV]) {
			expect(runToStdout(binary, { cwd: incrementalDirectory("writer"), env })).toBe(
				expected,
			);
		}
	}
});

it.each(["watch", "watch-recursive"])(
	"matches Node's notifications for %s and closes on return",
	(name) => {
		const expected = incrementalReference(name);
		for (const binary of backends(pair)) {
			for (const env of [{}, STRESS_ENV]) {
				expect(runToStdout(binary, { cwd: incrementalDirectory(name), env })).toBe(
					expected,
				);
			}
		}
	},
);

it("rejects a pending watch on abort and releases the watcher", () => {
	const expected = incrementalReference("watch-abort");
	for (const binary of backends(pair)) {
		const stdout = runToStdout(binary, {
			cwd: incrementalDirectory("watch-abort"),
			env: STRESS_ENV,
		});
		expect(stdout).toBe(expected);
	}
});
