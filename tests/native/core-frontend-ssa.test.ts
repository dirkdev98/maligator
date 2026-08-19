import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-frontend-ssa-"));
const expected = ["core-frontend-ssa PASS"];

describe("direct Core frontend SSA", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/core-frontend-ssa.js",
				name: `core-frontend-ssa-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
			}),
		);
	}, 600_000);

	it("preserves numeric, boxed, loop, and exceptional joins", () => {
		for (const binary of binaries) assertExactLines(runToStdout(binary), expected);
	});

	it("preserves joins under GC stress", () => {
		for (const binary of binaries) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), expected);
		}
	});
});
