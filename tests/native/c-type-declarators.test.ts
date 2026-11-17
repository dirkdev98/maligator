import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves nested C declarators and optional bounds across backends and collection", () => {
	const fixture = "tests/local/c-type-declarators.mjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-c-type-declarators-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "c-type-declarators",
			outDir,
			config: resolveBuildConfig({
				engine: {
					primordials: "mutable",
					eval: false,
					realms: false,
					intl: { enabled: false },
				},
				surface: { node: false, webPlatform: false },
			}),
		});
		for (const binary of [pair.compiled, pair.interpreted])
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
