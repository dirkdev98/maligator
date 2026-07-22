import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-binary-fast-path.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-binary-"));

describe("interpreter boxed-number binary fast path", () => {
	let expected: string;
	let binaries: Array<string>;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture,
				name: `interpreter-binary-${compiled ? "compiled" : "interpreted"}`,
				compiled,
				evalEnabled: false,
				realmsEnabled: false,
				intlEnabled: false,
				regexpEnabled: false,
				webPlatformEnabled: false,
				outDir,
			}),
		);
	}, 600_000);

	it("matches Node across numeric tags and generic fallbacks", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toBe(expected);
		}
	});
});
