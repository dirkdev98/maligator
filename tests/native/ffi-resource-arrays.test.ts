import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { ffiResourceArrayCompilerEnvironment } from "../helpers/ffi-resource-array-compiler.ts";

const repository = path.resolve(import.meta.dirname, "../..");
it.each(["compiled", "interpreted"])(
	"owns resource-array elements transactionally through %s calls",
	(backend) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-resource-arrays-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-resource-arrays"), directory, {
				recursive: true,
			});

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
					env: ffiResourceArrayCompilerEnvironment(process.env),
				},
			);
			expect(
				built.status,
				[built.error?.message, built.signal, built.stderr, built.stdout]
					.filter(Boolean)
					.join("\n"),
			).toBe(0);
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
