import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/worker-dynamic-entry/main.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-dynamic-entry-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });

it.each([true, false])(
	"starts a worker from a module URL built by a helper (compiled=%s)",
	(compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `worker-dynamic-entry-${compiled ? "compiled" : "interpreted"}`,
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled,
		});
		expect(runToStdout(binary, { timeoutMs: 30_000 })).toBe(expected);
	},
	300_000,
);
