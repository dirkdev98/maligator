import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-url-instance-layout.cjs";
const directory = mkdtempSync(path.join(tmpdir(), "mal-url-instance-layout-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("legacy URL instance layout", () => {
	let expected: string;
	let binaries: Array<string>;
	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "url-instance-layout",
			outDir: directory,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		binaries = [pair.compiled, pair.interpreted];
	}, 600_000);
	it("preserves ordered fields, descriptors, independent storage, subclasses and custom prototypes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
		}
	});
	it("retains custom prototypes and values written into the initial slot storage under collection", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
				expected,
			);
		}
	});
});
