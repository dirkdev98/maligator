import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dynamic-arguments-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["mutable", "locked"] as const)(
	"preserves incoming argument identity across nested calls and collections with %s primordials",
	(primordials) => {
		const fixture = "tests/local/arguments-incoming.cjs";
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `arguments-incoming-${primordials}`,
			outDir,
			config: resolveBuildConfig({ engine: { primordials, eval: false, realms: false } }),
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	},
	300000,
);

it("observes inherited out-of-range argument indices", () => {
	const fixture = "tests/local/arguments-inherited-index.cjs";
	const pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "arguments-inherited-index",
		outDir,
		config: resolveBuildConfig({
			engine: { primordials: "mutable", eval: false, realms: false },
		}),
	});
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	for (const binary of [pair.compiled, pair.interpreted])
		expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
}, 300000);
