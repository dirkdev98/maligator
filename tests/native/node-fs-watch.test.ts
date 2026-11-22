import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-fs-watch-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each([
	["node:fs", "node-fs-watch"],
	["node:fs/promises", "node-fs-promises-watch"],
])("%s watchers", (_module, name) => {
	let expected: string;
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;

	beforeAll(() => {
		const fixture = `tests/local/${name}.mjs`;
		expected = execFileSync(process.execPath, ["--no-deprecation", fixture], {
			encoding: "utf8",
			timeout: 60_000,
		});
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name,
			mainFile: HOST_MAIN,
			outDir,
			evalEnabled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(pair.compiled, { timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node interpreted", () => {
		expect(runToStdout(pair.interpreted, { timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(runToStdout(pair.compiled, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(
			expected,
		);
	});
});

it.runIf(process.platform === "darwin")(
	"reports descriptor exhaustion while starting a directory watch",
	() => {
		const binary = buildNativeBinary({
			fixture: "tests/local/node-fs-watch-exhausted.mjs",
			name: "node-fs-watch-exhausted",
			outDir,
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			}),
		});
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(
			"/bin/sh",
			[
				"-c",
				'ulimit -n 32; exec "$@"',
				"watch-exhausted",
				invocation.executable,
				...invocation.args,
			],
			{
				encoding: "utf8",
				env: { ...process.env, MAL_GC_VERIFY: "1" },
				timeout: 30_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(
			result.status,
			result.stderr || result.stdout || result.signal || "no status",
		).toBe(0);
		expect(result.stdout).toBe("watch resource error EMFILE\n");
	},
);
