import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("managed heap sweep contracts", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "gc-minor-sweep",
			mainFile: "tests/fixtures/gc-minor-sweep/main.c",
		});
	});

	it("preserves survivor accounting, finalization, reclaimed cells, and block reuse", () => {
		assertPassLine(runToStdout(binary), "gc-minor-sweep");
	});

	it("maintains the same contracts with reclaimed payload poisoning", () => {
		assertPassLine(
			runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } }),
			"gc-minor-sweep",
		);
	});
});
