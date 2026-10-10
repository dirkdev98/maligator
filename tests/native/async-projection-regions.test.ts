import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/async-projection-regions.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-async-projection-regions-"));

describe("projection patterns inside resumable functions", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "async-projection-regions",
			outDir,
		}));
	}, 600_000);

	it("compiles split, RegExp, slice and object patterns after an await", () => {
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary)).toBe(expected);
	});
});
