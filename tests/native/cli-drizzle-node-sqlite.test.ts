import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Node CLI Drizzle SQLite integration", () => {
	it("builds and runs the split Drizzle driver graph", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"--config",
				"tests/local/cli-drizzle-node-sqlite.build.ts",
			],
			{
				cwd: repositoryRoot,
				env: process.env,
				encoding: "utf-8",
				timeout: 300_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout.split("\n")).toContain("RESULT 7/7");
		expect(result.stderr).toContain("Exited with code 0");
	}, 300_000);
});
