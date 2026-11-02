import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
it.each(["compiled", "interpreted"])(
	"preserves UTF8 string input ownership through %s calls and reentry",
	(backend) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-string-input-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-string-input"), directory, {
				recursive: true,
			});
			for (const [config, output] of [
				["maligator.build.ts", "string inputs passed"],
				["callback.build.ts", "callback string inputs passed"],
			]) {
				const built = spawnSync(
					process.execPath,
					[
						path.join(repository, "src/index.ts"),
						"build",
						"--production",
						"--config",
						config!,
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
				expect(executed.stdout.trim()).toBe(output);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
