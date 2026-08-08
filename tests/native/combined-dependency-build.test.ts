import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("combined Express, Valibot, and Drizzle product build", () => {
	it("keeps every generated translation unit below the compiler string ceiling", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"build",
				"--verbose",
				"--config",
				"tests/fixtures/express-5/combined-dependency-build.build.mts",
			],
			{
				cwd: repositoryRoot,
				env: process.env,
				encoding: "utf-8",
				timeout: 300_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stderr).toContain("Functions:");
		expect(result.stdout.trim()).toContain("combined-dependency-build");
	}, 300_000);
});
