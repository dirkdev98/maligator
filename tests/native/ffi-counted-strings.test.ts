import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/index.ts");
describe("counted UTF-8 strings", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-counted-strings-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-counted-strings"), project, {
			recursive: true,
		});
	});
	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});
	it.each(["compiled", "interpreted"])(
		"preserves byte lengths, NULs, errors and async ownership in %s calls",
		(backend) => {
			const built = spawnSync(
				process.execPath,
				[
					cliEntry,
					"build",
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
				env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("counted strings passed");
		},
		300_000,
	);
});
