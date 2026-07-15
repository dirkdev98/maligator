import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Node CLI native driver integration", () => {
	it("runs web-platform callbacks through the selected host event-loop driver", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"tests/local/cli-web-driver.js",
				"--config",
				"tests/local/cli-web-driver.build.ts",
			],
			{
				cwd: repositoryRoot,
				env: process.env,
				encoding: "utf-8",
				timeout: 120_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain("CLI_EVENT_LOOP_CALLBACK");
	});
});
