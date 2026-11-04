import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-constant-growth-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("keeps old values and property keys valid while loaded constant pools grow", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "constant-pool-growth",
		mainFile: "tests/fixtures/constant-pool-growth/main.c",
		outDir,
		config: resolveBuildConfig({
			engine: {
				eval: false,
				realms: false,
				regexp: false,
				intl: { features: ["collator"] },
			},
			surface: { node: false, webPlatform: false },
		}),
	});
	expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
		"constant-pool-growth PASS\n",
	);
}, 300_000);
