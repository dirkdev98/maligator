import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-at-direct.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-at-direct-"));

describe("guarded direct Array.prototype.at", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "array-at-direct",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "array-at-direct-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("preserves index conversion, holes, overrides, and generic receivers", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["array-at-direct PASS"]);
		}
	});
});
