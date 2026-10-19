import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/node-assert-messages.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-assert-messages-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("node:assert messages and validation", () => {
	let expected: string;
	const binaries: Record<string, string> = {};

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const compiled of [true, false]) {
			binaries[compiled ? "compiled" : "interpreted"] = buildNativeBinary({
				fixture,
				name: `node-assert-messages-${compiled ? "compiled" : "interpreted"}`,
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			});
		}
	}, 600_000);

	it.each(["compiled", "interpreted"])("matches Node when %s", (variant) => {
		expect(runToStdout(binaries[variant]!)).toBe(expected);
	});
});
