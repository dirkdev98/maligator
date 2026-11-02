import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
it.each(["compiled", "interpreted"])(
	"keeps C value alignment through %s arrays, workers and callbacks",
	(backend) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-aligned-value-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-aligned-values"), directory, {
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
				{ cwd: directory, encoding: "utf8", timeout: 240_000 },
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
				},
			});
			expect(executed.status, executed.stderr || executed.stdout).toBe(0);
			expect(executed.stdout.trim()).toBe("aligned values passed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
