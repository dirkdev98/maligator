import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/node-console.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-console-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("node:console Console class", () => {
	let expected: string;
	const binaries: Record<string, string> = {};

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const compiled of [true, false]) {
			binaries[compiled ? "compiled" : "interpreted"] = buildNativeBinary({
				fixture,
				name: `node-console-${compiled ? "compiled" : "interpreted"}`,
				mainFile: HOST_MAIN,
				outDir,
				compiled,
			});
		}
	}, 600_000);

	it.each(["compiled", "interpreted"])("matches Node when %s", (variant) => {
		expect(runToStdout(binaries[variant]!)).toBe(expected);
	});
});

it("formats multiple console arguments with Node's JSON substitution", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/node-console-json.mjs",
		name: "node-console-json",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: { MAL_TEST_CONSOLE_VALUE: "ok" } })).toBe(
		'value: {"value":"ok"}\n',
	);
}, 120_000);
