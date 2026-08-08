import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Express and Valibot product build", () => {
	it("emits bounded translation units for the combined dependency graph", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"build",
				"--verbose",
				"--config",
				"tests/fixtures/express-5/valibot-build.build.mts",
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
		expect(result.stdout.trim()).toContain("express-valibot");
	}, 300_000);
});
