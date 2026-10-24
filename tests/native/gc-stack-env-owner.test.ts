import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-stack-env-owner-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("conservative stack scan of a closure's captured scope", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/gc-stack-env-owner.cjs",
				name: compiled ? "gc-stack-env-owner-compiled" : "gc-stack-env-owner-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				compiled,
			}),
		);
	});

	it("leaves a dead lexical parent alone in both modes under GC stress", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain("ENV OWNER PASS");
		}
	});
});
