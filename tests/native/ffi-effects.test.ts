import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
describe("foreign call effects", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-effects-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-effects"), project, {
			recursive: true,
		});
	});
	afterAll(() => rmSync(project, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"]) {
		it.each([
			[".", "foreign effects passed"],
			["callback", "nested foreign callback passed"],
		])(
			`preserves %s C effects through ${backend} calls`,
			(directory, output) => {
				const cwd = path.join(project, directory);
				const built = spawnSync(
					process.execPath,
					[
						path.join(repositoryRoot, "src/index.ts"),
						"build",
						"--production",
						...(backend === "interpreted" ? ["--no-compiled"] : []),
					],
					{ cwd, env: process.env, encoding: "utf8", timeout: 240_000 },
				);
				expect(built.status, built.stderr || built.stdout).toBe(0);
				const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
					cwd,
					encoding: "utf8",
					timeout: 60_000,
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
				).toBe(0);
				expect(executed.stdout.trim()).toBe(output);
			},
			300_000,
		);
	}
});
