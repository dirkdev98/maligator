import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-number-to-fixed-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Number.prototype.toFixed", () => {
	it("rounds the exact binary value half up like Node across magnitudes and digit counts", () => {
		const fixture = path.join(outDir, "number-to-fixed.mjs");
		writeFileSync(
			fixture,
			`const values = [0, -0, 0.5, 1.5, 2.5, 1.005, 1.045, 8.345, 999.995, 0.1, 0.3,
  1e-7, 5e-21, 1e-25, 2 ** -70, 2 ** -71, 123.456, 4503599627370495.5,
  9007199254740991, 1e20, 1.0000000000000002, 0.9999999999999999];
let seed = 7;
function next() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
for (let i = 0; i < 400; i++) values.push((next() - 0.5) * 10 ** (Math.floor(next() * 36) - 22));
for (const value of values) {
  const row = [];
  for (let digits = 0; digits <= 21; digits++) row.push(value.toFixed(digits), (-value).toFixed(digits));
  console.log(row.join(" "));
}
`,
		);
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const binary = buildNativeBinary({
			fixture,
			name: "number-to-fixed",
			compiled: true,
			outDir,
		});
		expect(runToStdout(binary)).toBe(expected);
	}, 600_000);
});
