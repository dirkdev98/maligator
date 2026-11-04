import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

it("restores oversized profiling metadata after the worker replaces its sidecar", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-compiler-profile-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/fixtures/compiler-profile-result/main.mts",
			name: "compiler-profile-result",
			outDir: directory,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, intl: { enabled: false } },
				surface: { node: true, webPlatform: false },
			}),
		});
		for (const binary of [pair.compiled, pair.interpreted])
			expect(
				runToStdout(binary, { env: { MAL_GC_VERIFY: "1" }, timeoutMs: 30_000 }),
			).toBe("compiler profile handoff passed\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);
