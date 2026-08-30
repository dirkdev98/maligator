import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/local-exception-flow.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-local-exception-flow-"));

describe("local exception flow", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "local-exception-flow",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		}));
	}, 600_000);

	it.each([
		["compiled", () => runToStdout(compiled)],
		["interpreted", () => runToStdout(interpreted)],
		["compiled GC stress", () => runToStdout(compiled, { env: STRESS_ENV })],
		["interpreted GC stress", () => runToStdout(interpreted, { env: STRESS_ENV })],
	])("preserves catch and finally completion order in %s mode", (_name, run) => {
		expect(run()).toBe(expected);
	});
});
