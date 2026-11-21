import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const driverConfig = path.join(repositoryRoot, "tests/local/cli-web-driver.build.ts");

describe("Node CLI native driver integration", () => {
	it("runs web-platform callbacks through the selected host event-loop driver", () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"tests/local/cli-web-driver.js",
				"--config",
				driverConfig,
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

it("matches production console and rejection behavior for web-only programs", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "mal-cli-web-parity-"));
	const entry = path.join(cwd, "web-only.mjs");
	const cli = path.join(repositoryRoot, "src/index.ts");
	const options = { cwd, encoding: "utf8" as const, timeout: 120_000 };
	try {
		writeFileSync(
			entry,
			`console.log("web", { host: new URL("https://example.com").host });
Promise.reject("web-only rejection");
setTimeout(() => console.log("timer ran"), 1);
`,
		);
		const built = spawnSync(
			process.execPath,
			[cli, "build", entry, "--config", driverConfig, "--production"],
			options,
		);
		expect(built.status, built.stderr || built.error?.message).toBe(0);
		const native = spawnSync(built.stdout.trim(), [], options);
		const development = spawnSync(
			process.execPath,
			[cli, "run", entry, "--config", driverConfig],
			options,
		);
		expect(native.status, native.stderr || native.error?.message).toBe(0);
		expect(development.status, development.stderr || development.error?.message).toBe(
			native.status,
		);
		expect(native.stdout).toContain("timer ran");
		expect(development.stdout).toBe(native.stdout);
		expect(native.stderr).toContain("Uncaught (in promise) web-only rejection");
		expect(development.stderr).toContain("Uncaught (in promise) web-only rejection");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}, 300_000);
