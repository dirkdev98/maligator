import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
describe("waiting C callback results", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-waiting-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-waiting"), project, {
			recursive: true,
		});
		const extension = process.platform === "darwin" ? "dylib" : "so";
		const built = spawnSync(
			process.env.CC ?? "cc",
			[
				"-shared",
				"-fPIC",
				"-std=c11",
				"-pthread",
				path.join(project, "waiting.c"),
				"-o",
				path.join(project, `libwaiting.${extension}`),
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(built.status, built.stderr).toBe(0);
	});
	afterAll(() => rmSync(project, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"]) {
		it.each([
			["main.ts", 0, "waiting callbacks passed"],
			["invalid-result.ts", 1, "callback result"],
			["shutdown.ts", 1, "waiting shutdown requested"],
			["shutdown-child.ts", 1, "waiting child shutdown requested"],
		] as const)(
			`preserves %s with ${backend} calls`,
			(entry, status, output) => {
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
					timeout: 15_000,
					env: {
						...process.env,
						MAL_GC_STRESS: "1",
						MAL_GC_VERIFY: "1",
						MAL_GC_AT_EXIT: "1",
					},
				});
				expect(executed.status, executed.stderr || executed.stdout).toBe(status);
				expect(status === 0 ? executed.stdout.trim() : executed.stderr).toContain(output);
				expect(executed.stderr).not.toMatch(
					/runtime error:|AddressSanitizer|UndefinedBehaviorSanitizer/,
				);
			},
			300_000,
		);
	}
});
