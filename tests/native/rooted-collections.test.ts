import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-rooted-collections-"));
const expected = ["rooted-collections PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("rooted collection snapshots and string parts", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/rooted-collections.js",
			name: "rooted-collections",
			outDir,
		}));
	});

	it("preserves caller semantics in compiled code", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("preserves roots under compiled GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("preserves caller semantics in interpreted code", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves roots under interpreted GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});
});
