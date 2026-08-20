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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-object-slots-"));
const expected = ["core-object-slots PASS"];

describe("Core own data slots", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/core-object-slots.js",
				name: `core-object-slots-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
			}),
		);
	}, 600_000);

	it("keeps accessor, proxy, shape, escape, and weak-reference semantics", () => {
		for (const binary of binaries) assertExactLines(runToStdout(binary), expected);
	});

	it("keeps them under GC stress", () => {
		for (const binary of binaries) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), expected);
		}
	});
});
