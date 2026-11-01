import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/index.ts");
describe("retained byte ranges in caller-owned C state", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-managed-state-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-managed-state"), project, {
			recursive: true,
		});
	});
	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});
	it.each(["compiled", "interpreted"])(
		"retains and bounds C-mutated buffers through %s calls",
		(backend) => {
			const built = spawnSync(
				process.execPath,
				[
					cliEntry,
					"build",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{
					cwd: project,
					env: process.env,
					encoding: "utf8",
					timeout: 240_000,
				},
			);
			expect(built.status, built.stderr || built.stdout).toBe(0);
			const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
				cwd: project,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("managed state passed");
		},
		300_000,
	);
	it.each(["compiled", "interpreted"])(
		"joins a running managed call during %s shutdown",
		(backend) => {
			const built = spawnSync(
				process.execPath,
				[
					cliEntry,
					"build",
					"shutdown.ts",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{
					cwd: project,
					env: process.env,
					encoding: "utf8",
					timeout: 240_000,
				},
			);
			expect(built.status, built.stderr || built.stdout).toBe(0);
			const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
				cwd: project,
				encoding: "utf8",
				timeout: 5000,
				env: {
					...process.env,
					MAL_GC_STRESS: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_AT_EXIT: "1",
				},
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(1);
			expect(executed.stderr).toContain("managed shutdown requested");
			expect(executed.stderr).not.toMatch(
				/runtime error:|AddressSanitizer|UndefinedBehaviorSanitizer/,
			);
		},
		300_000,
	);
});
