import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/global-console-inspect.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-global-console-inspect-"));
const config = resolveBuildConfig({});
const env = { FORCE_COLOR: "0" };
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function expectNodeOutput(fixture: string, name: string, compiled: boolean): void {
	const expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	const binary = buildNativeBinary({
		fixture,
		name,
		outDir,
		compiled,
		config,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env })).toBe(expected);
}

it.each([
	["compiled", true],
	["interpreted", false],
])(
	"matches Node console output without process on the %s backend",
	(backend, compiled) => {
		expectNodeOutput(fixture, `global-console-inspect-${backend}`, compiled);
	},
);

it("matches Node when a sloppy receiver supplies the global console", () => {
	expectNodeOutput(
		"tests/local/global-console-receiver.cjs",
		"global-console-receiver",
		true,
	);
});
