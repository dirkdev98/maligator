import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-split-trim.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-split-trim-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("split cursor trim lengths", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves field content, whitespace and protocol fallback with %s primordials",
		(primordials) => {
			const env = { MAL_SPLIT_POLICY: primordials, MAL_HOST_GC: "1" };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `split-trim-${primordials}`,
				outDir,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false, intl: { enabled: false } },
					surface: { node: true },
				}),
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const mode of sanitized ? [{}] : [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...env, ...mode } })).toBe(expected);
		},
	);
});
