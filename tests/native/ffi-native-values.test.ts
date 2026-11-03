import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
it.each(
	["compiled", "interpreted"].flatMap((backend) => [
		{ backend, entry: "main.ts", output: "native values passed" },
		{ backend, entry: "extensions.ts", output: "native extensions passed" },
		{ backend, entry: "zero-only.ts", output: "native zero passed" },
		{ backend, entry: "constant-only.ts", output: "native constants passed" },
	]),
)(
	"preserves native values through $entry with $backend calls",
	({ backend, entry, output }) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-native-values-"));
		try {
			cpSync(path.join(repository, "tests/fixtures/ffi-native-values"), directory, {
				recursive: true,
			});
			const built = spawnSync(
				process.execPath,
				[
					path.join(repository, "src/index.ts"),
					"build",
					entry,
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
			expect(executed.stdout.trim()).toBe(output);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
