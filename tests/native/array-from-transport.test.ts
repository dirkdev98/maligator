import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-from-transport.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-array-from-transport-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each([false, true])("Array.from result transport with realms=%s", (realms) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `array-from-transport-${realms}`,
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: {
					primordials: "mutable",
					realms,
					eval: false,
					regexp: false,
					intl: { enabled: false },
					temporal: false,
				},
				surface: { node: true, webPlatform: false },
			}),
		});
	});
	it.each([
		"retained",
		"method-string",
		"method-number",
		"method-object",
		"method-shared",
		"method-getter",
		"namespace",
		"namespace-getter",
		"argument-replace",
		"iterator-replace",
		"mapper-replace",
		"iterator-throw",
		"mapper-throw",
		"custom-constructor",
		"borrowed",
	])("preserves the %s result and observation order", (scenario) => {
		const env = { ARRAY_TRANSPORT_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
		}
	});
});
