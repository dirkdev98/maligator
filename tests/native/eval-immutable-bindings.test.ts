import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-immutable-bindings-"));

describe("direct eval writes to the caller's immutable bindings", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/eval-immutable-bindings.js",
			name: "eval-immutable-bindings",
			outDir,
		}));
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("throw in strict code in %s mode", (_mode, binary) => {
		assertPassLine(runToStdout(binary()), "eval-immutable-bindings");
	});
});
