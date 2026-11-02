import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/index.ts");

describe("caller-owned C state", () => {
	let project: string;
	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-caller-storage-"));
		cpSync(path.join(repositoryRoot, "tests/fixtures/ffi-caller-storage"), project, {
			recursive: true,
		});
	});
	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});
	it.each(["compiled", "interpreted"])(
		"preserves state lifetime, identity, and alignment through %s calls",
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
			const binary = built.stdout.trim().split("\n").at(-1)!;
			const executed = spawnSync(binary, [], {
				cwd: project,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("caller storage passed");
		},
		300_000,
	);
	it.each(["compiled", "interpreted"])(
		"links a factory-only opaque import through %s calls",
		(backend) => {
			const built = spawnSync(
				process.execPath,
				[
					cliEntry,
					"build",
					"opaque-only.ts",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{ cwd: project, encoding: "utf8", timeout: 240_000 },
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
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
		},
		300_000,
	);
	it.each(
		["compiled", "interpreted"].flatMap((backend) =>
			["dispose", "collect"].map((lifetime) => ({ backend, lifetime })),
		),
	)(
		"releases queued callback work after $lifetime through $backend calls",
		({ backend, lifetime }) => {
			const built = spawnSync(
				process.execPath,
				[
					cliEntry,
					"build",
					`callbacks-${lifetime}.ts`,
					"--config",
					"callbacks.build.ts",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{ cwd: project, env: process.env, encoding: "utf8", timeout: 240_000 },
			);
			expect(built.status, built.stderr || built.stdout).toBe(0);
			const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
				cwd: project,
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
			});
			expect(
				executed.status,
				[executed.error?.message, executed.signal, executed.stderr, executed.stdout]
					.filter(Boolean)
					.join("\n"),
			).toBe(0);
			expect(executed.stdout.trim()).toBe("caller callback released");
		},
		300_000,
	);
});
