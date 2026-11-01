import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
describe("one-shot C close completions", () => {
	let project: string;
	let uvProject: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-close-callback-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-close-callback"), project, {
			recursive: true,
		});
		uvProject = path.join(project, "libuv");
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-libuv-close"), uvProject, {
			recursive: true,
		});
	});
	afterAll(() => rmSync(project, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"]) {
		it(`closes real libuv timer storage from an active ${backend} callback`, () => {
			const built = spawnSync(
				process.execPath,
				[
					path.join(repositoryRoot, "src/index.ts"),
					"build",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{ cwd: uvProject, env: process.env, encoding: "utf8", timeout: 240_000 },
			);
			expect(built.status, built.stderr || built.stdout).toBe(0);
			const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
				cwd: uvProject,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					...process.env,
					MAL_GC_STRESS: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_AT_EXIT: "1",
				},
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("libuv close passed");
		}, 300_000);
		for (const entry of ["main.ts", "combined.ts", "shutdown.ts", "shutdown-keyed.ts"]) {
			it(`retains close storage through ${entry} with ${backend} calls`, () => {
				const built = spawnSync(
					process.execPath,
					[
						path.join(repositoryRoot, "src/index.ts"),
						"build",
						entry,
						"--production",
						...(backend === "interpreted" ? ["--no-compiled"] : []),
					],
					{ cwd: project, env: process.env, encoding: "utf8", timeout: 240_000 },
				);
				expect(built.status, built.stderr || built.stdout).toBe(0);
				const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
					cwd: project,
					encoding: "utf8",
					timeout: 10_000,
					env: {
						...process.env,
						MAL_GC_STRESS: "1",
						MAL_GC_VERIFY: "1",
						MAL_GC_AT_EXIT: "1",
					},
				});
				const succeeds = entry === "main.ts" || entry === "combined.ts";
				expect(executed.status, executed.stderr || executed.stdout).toBe(
					succeeds ? 0 : 1,
				);
				if (succeeds)
					expect(executed.stdout.trim()).toBe(
						entry === "combined.ts"
							? "combined close callbacks passed"
							: "close callbacks passed",
					);
				else expect(executed.stderr).toContain("close shutdown requested");
				expect(executed.stderr).not.toMatch(
					/runtime error:|AddressSanitizer|UndefinedBehaviorSanitizer/,
				);
			}, 300_000);
		}
	}
});
