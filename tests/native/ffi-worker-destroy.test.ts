import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/index.ts");
describe("worker-thread C resource destruction", () => {
	let project: string;
	const binaries = new Map<string, string>();
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-worker-destroy-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-worker-destroy"), project, {
			recursive: true,
		});
	});
	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});
	function binary(entry: string, backend: string): string {
		const key = `${entry}:${backend}`;
		const cached = binaries.get(key);
		if (cached !== undefined) return cached;
		const built = spawnSync(
			process.execPath,
			[
				cliEntry,
				"build",
				entry,
				"--production",
				...(backend === "interpreted" ? ["--no-compiled"] : []),
			],
			{ cwd: project, env: process.env, encoding: "utf8", timeout: 240_000 },
		);
		expect(built.status, built.stderr || built.stdout).toBe(0);
		const result = path.join(project, `${entry}-${backend}`);
		cpSync(built.stdout.trim().split("\n").at(-1)!, result);
		binaries.set(key, result);
		return result;
	}
	it.each(["compiled", "interpreted"])(
		"preserves successful and failed destructor lifetimes through %s calls",
		(backend) => {
			const executed = spawnSync(binary("main.ts", backend), [], {
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
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("worker destruction passed");
		},
		300_000,
	);
	it.each(
		["compiled", "interpreted"].flatMap((backend) =>
			["running", "completed", "queued"].map((mode) => ({ backend, mode })),
		),
	)(
		"reconciles discarded $mode destructors during $backend shutdown",
		({ backend, mode }) => {
			const executed = spawnSync(binary("shutdown.ts", backend), [mode], {
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
			expect(executed.signal, executed.stderr).toBeNull();
			expect(executed.status, executed.stderr).toBe(1);
			expect(executed.stderr).toContain("worker shutdown requested");
			expect(executed.stderr).toContain("worker cleanup complete");
		},
		300_000,
	);
});
