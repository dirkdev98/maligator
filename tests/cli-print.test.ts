import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

it("prints generated C without building or publishing an executable artifact", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-cli-print-"));
	try {
		writeFileSync(path.join(directory, "main.mts"), "console.log(42);\n");
		writeFileSync(
			path.join(directory, "maligator.build.mts"),
			`export default {
	entry: "main.mts",
	engine: { eval: false, regexp: false, intl: { enabled: false } },
	surface: { node: false, webPlatform: false },
};\n`,
		);
		const artifact = path.join(directory, "artifact");
		const result = spawnSync(
			process.execPath,
			[
				path.resolve("src/index.ts"),
				"build",
				"--config",
				"maligator.build.mts",
				"--production",
				"--print",
				"--artifact",
				artifact,
			],
			{ cwd: directory, env: cleanTestEnvironment(), encoding: "utf8", timeout: 30_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.length).toBeGreaterThan(0);
		expect(existsSync(artifact)).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
