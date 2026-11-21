import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-async-context-null-entry.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-async-context-null-entry-"));

describe("AsyncLocalStorage contexts installed by callbacks that start without one", () => {
	let binaries: Array<string>;
	let expected: string;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture,
				name: `node-async-context-null-entry-${compiled ? "compiled" : "interpreted"}`,
				mainFile: HOST_MAIN,
				outDir,
				compiled,
			}),
		);
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
	});

	it("scopes enterWith to the callback's continuations like Node", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toBe(expected);
		}
	});

	it("keeps installed contexts rooted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});
