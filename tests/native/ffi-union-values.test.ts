import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
let project: string;
beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "mal-ffi-union-values-"));
	cpSync(join(repo, "tests/fixtures/ffi-union-values"), project, { recursive: true });
});
afterAll(() => rmSync(project, { recursive: true, force: true }));
it.each(
	["compiled", "interpreted"].flatMap((backend) => [
		{
			backend,
			directory: ".",
			behavior: "converts only the selected union member",
			output: "union values passed",
		},
		{
			backend,
			directory: "getter-pins",
			behavior: "pins handle arguments while union getters run",
			output: "union getter pins passed",
		},
		{
			backend,
			directory: "tagged",
			behavior: "selects tagged union payloads before reading getters",
			output: "tagged union values passed",
		},
	]),
)(
	"$behavior through $backend calls",
	({ backend, directory, output }) => {
		const cwd = join(project, directory);
		const built = spawnSync(
			process.execPath,
			[
				join(repo, "src/index.ts"),
				"build",
				"--production",
				...(backend === "interpreted" ? ["--no-compiled"] : []),
			],
			{ cwd, env: process.env, encoding: "utf8", timeout: 240000 },
		);
		expect(built.status, built.stderr || built.stdout).toBe(0);
		const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
			cwd,
			env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
			encoding: "utf8",
			timeout: 30000,
		});
		expect(executed.status, executed.stderr || executed.stdout).toBe(0);
		expect(executed.stdout.trim()).toBe(output);
	},
	300000,
);
