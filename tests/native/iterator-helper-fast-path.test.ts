import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-iterator-helper-fast-path-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const expected = ["iterator-helper-fast-path PASS"];

describe("iterator and iterator-helper native fast paths", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/iterator-helper-fast-path.js",
			name: "iterator-helper-fast-path",
			outDir,
		}));
	}, 600_000);

	it("preserves public, chained, overridden, and closing semantics", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps nested helper state rooted under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});

it("keeps the selected generator helpers and their closing protocol", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/iterator-member-selection.mjs",
		name: "iterator-member-selection",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("6,true\n");
}, 120_000);
