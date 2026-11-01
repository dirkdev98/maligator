import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
describe("native callback result lifetimes", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-callback-results-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-callback-results"), project, {
			recursive: true,
		});
	});
	afterAll(() => rmSync(project, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"]) {
		for (const entry of [
			"main.ts",
			"shutdown.ts",
			"cancel.ts",
			"retained.ts",
			"retained-shutdown.ts",
		]) {
			it(`retains native callback results through ${entry} with ${backend} calls`, () => {
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
					timeout: 30_000,
					env: {
						...process.env,
						MAL_GC_STRESS: "1",
						MAL_GC_VERIFY: "1",
						MAL_GC_AT_EXIT: "1",
					},
				});
				expect(
					executed.status,
					[executed.error?.message, executed.signal, executed.stderr, executed.stdout]
						.filter(Boolean)
						.join("\n"),
				).toBe(entry === "main.ts" || entry === "retained.ts" ? 0 : 1);
				if (entry === "main.ts" || entry === "retained.ts")
					expect(executed.stdout.trim()).toBe(
						entry === "main.ts"
							? "callback results passed"
							: "retained callback results passed",
					);
				else expect(executed.stderr).toContain("pointer shutdown requested");
				expect(executed.stderr).not.toMatch(
					/runtime error:|AddressSanitizer|UndefinedBehaviorSanitizer/,
				);
			}, 300_000);
		}
	}
});
