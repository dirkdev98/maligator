import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
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
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const root = mkdtempSync(path.join(tmpdir(), "mal-maligator-fs-"));
let runs = 0;
let defaultSurface: BackendPairResult;
let webSurface: BackendPairResult;

beforeAll(() => {
	const build = (name: string, webPlatformEnabled: boolean) =>
		buildBackendPairFromOneProgramImage({
			fixture: "tests/local/maligator-fs.mjs",
			name,
			outDir: path.join(root, "out"),
			mainFile: HOST_MAIN,
			webPlatformEnabled,
			nodeEnabled: false,
		});
	defaultSurface = build("maligator-fs", false);
	webSurface = build("maligator-fs-web", true);
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
function reference(args: Array<string> = []): { stdout: string; tree: Array<string> } {
	const cwd = workingDirectory();
	const stdout = execFileSync(
		process.execPath,
		[path.resolve("tests/local/maligator-fs-node.mjs"), ...args],
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
	const expected = reference(["--without-url"]);
	if (process.getuid?.() !== 0) {
		expect(expected.stdout).toContain(
			"locked write FileSystemError true EACCES open locked/new.txt",
		);
	}
	for (const binary of [defaultSurface.compiled, defaultSurface.interpreted]) {
		for (const env of [{}, STRESS_ENV]) expectScenario(binary, expected, env);
	}
});

it("takes file: URLs where the web surface provides URL", () => {
	const expected = reference();
	expect(expected.stdout).toContain("url /tmp/a b.txt");
	for (const binary of [webSurface.compiled, webSurface.interpreted]) {
		expectScenario(binary, expected);
	}
});
