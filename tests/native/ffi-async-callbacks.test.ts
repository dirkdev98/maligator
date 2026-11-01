import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
describe("async C callback ownership", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-async-callbacks-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-async-callbacks"), project, {
			recursive: true,
		});
	});
	afterAll(() => rmSync(project, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"]) {
		it.each([
			["main.ts", ""],
			["retained.ts", ""],
			["retained-shutdown.ts", ""],
			["replaced.ts", ""],
			["replaced-shutdown.ts", "queued"],
			["replaced-shutdown.ts", "running"],
			["shutdown.ts", ""],
			["shutdown.ts", "string"],
			["shutdown.ts", "handle"],
			["shutdown.ts", "out"],
			["wrong-thread.ts", ""],
		])(
			`preserves %s %s through ${backend} calls`,
			(entry, mode) => {
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
				const executed = spawnSync(
					built.stdout.trim().split("\n").at(-1)!,
					mode === "" ? [] : [mode],
					{
						cwd: project,
						encoding: "utf8",
						timeout: 15_000,
						env: {
							...process.env,
							MAL_GC_STRESS: "1",
							MAL_GC_VERIFY: "1",
							MAL_GC_AT_EXIT: "1",
						},
					},
				);
				if (entry === "wrong-thread.ts") {
					expect(executed.signal, executed.stderr).toBe("SIGABRT");
					expect(executed.stderr).toContain(
						"a C library called back into JavaScript from another thread",
					);
				} else {
					const succeeds =
						entry === "main.ts" || entry === "retained.ts" || entry === "replaced.ts";
					const successMessage =
						entry === "replaced.ts"
							? "replaced async callbacks passed"
							: entry === "retained.ts"
								? "retained async callbacks passed"
								: "async callbacks passed";
					expect(executed.status, executed.stderr || executed.stdout).toBe(
						succeeds ? 0 : 1,
					);
					expect(succeeds ? executed.stdout.trim() : executed.stderr).toContain(
						succeeds ? successMessage : "async callback shutdown requested",
					);
				}
				expect(executed.stderr).not.toMatch(
					/runtime error:|AddressSanitizer|UndefinedBehaviorSanitizer/,
				);
			},
			300_000,
		);
	}
});
