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

const fixture = "tests/local/object-has-own-known.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-has-own-known-"));

describe("locked exact Object.hasOwn", () => {
	let compiled: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "object-has-own-known",
			compiled: true,
			outDir,
		});
	}, 600_000);

	it("preserves own-property, Proxy, coercion, and throw semantics", () => {
		assertExactLines(runToStdout(compiled), ["object-has-own-known PASS"]);
	});

	it("remains safe under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), [
			"object-has-own-known PASS",
		]);
	});
});
