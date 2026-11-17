import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-super-"));

describe("derived constructor eval and arrow super", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/eval-super.js",
			name: "eval-super",
			outDir,
		}));
	});

	it("preserves eval and arrow initialization in compiled code", () => {
		assertPassLine(runToStdout(compiled), "eval-super");
	});

	it("preserves eval and arrow initialization under interpreted GC stress", () => {
		assertPassLine(
			runToStdout(interpreted, {
				env: { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
				timeoutMs: 60_000,
			}),
			"eval-super",
		);
	});
});
describe("reentrant super initialization", () => {
	const fixture = "tests/local/reentrant-super.mjs";
	const reference = JSON.parse(
		execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
	) as Record<string, unknown>;
	let outputs: Array<Record<string, unknown>>;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "reentrant-super",
			outDir,
		});
		outputs = [pair.compiled, pair.interpreted].flatMap((binary) =>
			[{}, STRESS_ENV].map(
				(env) => JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>,
			),
		);
	});

	it.each([
		["parent", "rejects outer binding after parent reentry initializes this"],
		["eval", "keeps eval super tied to the owning constructor state"],
		["iterator", "observes initialization performed by spread iteration"],
		["abrupt", "preserves an abrupt outer parent after successful reentry"],
	])("%s: %s", (name) => {
		for (const output of outputs) expect(output[name]).toEqual(reference[name]);
	});
});
