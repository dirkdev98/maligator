import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("writes identical UTF-8 bytes across fragment and encoding boundaries", () => {
	const fixture = "tests/local/generated-source.mts";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-source-writer-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "generated-source",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: { eval: false, realms: false },
				surface: { node: true, webPlatform: false },
			}),
		});
		for (const binary of [pair.compiled, pair.interpreted])
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
