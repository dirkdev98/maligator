import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
const repository = path.resolve(import.meta.dirname, "../..");
it.each(["compiled", "interpreted"])(
	"owns resource-array elements transactionally through %s calls",
	(backend) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-resource-arrays-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-resource-arrays"), directory, {
				recursive: true,
			});
			const compiler = path.join(directory, "calloc-cc.mjs");
			writeFileSync(
				compiler,
				[
					`#!${process.execPath}`,
					'import { spawnSync } from "node:child_process";',
					"const args = process.argv.slice(2);",
					'const result = spawnSync("clang", [...(args.some((arg) => arg.endsWith("/mal_ffi.c")) ? ["-Dcalloc=array_test_calloc"] : []), ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });',
					'process.stdout.write(args.includes("--version") ? result.stdout.replace(/$/m, " [array calloc interposition]") : result.stdout);',
					"process.stderr.write(result.stderr);",
					"process.exitCode = result.status ?? 1;",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);

			const built = spawnSync(
				process.execPath,
				[
					path.join(repository, "src/index.ts"),
					"build",
					"--production",
					...(backend === "interpreted" ? ["--no-compiled"] : []),
				],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 240_000,
					env: { ...process.env, CC: compiler },
				},
			);
			expect(built.status, built.stderr || built.stdout).toBe(0);
			const executed = spawnSync(built.stdout.trim().split("\n").at(-1)!, [], {
				cwd: directory,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					...process.env,
					MAL_GC_STRESS: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_AT_EXIT: "1",
					MAL_ALLOC_FAIL_TEST: "1",
					MAL_HOST_GC: "1",
				},
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("resource arrays passed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
