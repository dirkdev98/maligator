import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Node CLI AsyncLocalStorage integration", () => {
	it("propagates context through an awaited async callback", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"--config",
				"tests/local/cli-async-local-storage.build.ts",
			],
			{
				cwd: repositoryRoot,
				env: process.env,
				encoding: "utf-8",
				timeout: 120_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout.split("\n")).toContain("als-ok");
	});
});
