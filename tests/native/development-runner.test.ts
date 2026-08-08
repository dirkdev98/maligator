import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("development wire runner", () => {
	it("runs Node host modules and preserves AOT argument layout without generated C", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-dev-runner-"));
		const entrypoint = path.join(directory, "entry.mjs");
		const config = path.join(directory, "maligator.build.mjs");
		writeFileSync(
			entrypoint,
			'import process from "node:process";\n' +
				"setTimeout(() => console.log(JSON.stringify(process.argv.slice(1))), 1);\n",
		);
		writeFileSync(config, "export default { surface: { node: true } };\n");

		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				entrypoint,
				"--config",
				config,
				"--verbose",
				"--",
				"two words",
				"--flag",
			],
			{
				cwd: repositoryRoot,
				env: process.env,
				encoding: "utf-8",
				timeout: 300_000,
			},
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout.trim()).toBe('["<compiled>","two words","--flag"]');
		expect(result.stderr).toContain("Execution backend: interpreted development image");
		expect(result.stderr).toContain("Prepare development runtime completed");
		expect(result.stderr).not.toContain("Generate native code");
	}, 300_000);
});
