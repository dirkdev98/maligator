import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-async-iterator-close-"));

describe("AsyncIteratorClose", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/async-iterator-close.js",
			name: "async-iterator-close",
			outDir,
		}));
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)("passes %s", (_name, binary) => {
		assertPassLine(runToStdout(binary()), "async-iterator-close");
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)("retains close state under %s GC stress", (_name, binary) => {
		assertPassLine(runToStdout(binary(), { env: STRESS_ENV }), "async-iterator-close");
	});
});
