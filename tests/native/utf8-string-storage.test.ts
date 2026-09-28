import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

describe("UTF-8 string storage and decoded-unit limits", () => {
	const config = resolveBuildConfig({
		engine: { primordials: "mutable", regexp: false },
		surface: { webPlatform: true, node: true },
	});
	let storageBinary: string;
	let boundariesBinary: string;

	beforeAll(() => {
		storageBinary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "utf8-string-storage",
			mainFile: "tests/fixtures/utf8-string-storage/main.c",
			config,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		boundariesBinary = buildNativeBinary({
			fixture: "tests/local/utf8-string-boundaries.mjs",
			name: "utf8-string-boundaries",
			mainFile: HOST_MAIN,
			config,
		});
	}, 600_000);

	it("preserves compact decoding, replacement counts, maximum lengths and adopted backing", () => {
		expect(runToStdout(storageBinary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
			"utf8-string-storage PASS\n",
		);
	});

	it("applies decoded limits and BOM handling at streaming and body entrypoints", () => {
		expect(runToStdout(boundariesBinary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
			"utf8-string-boundaries PASS\n",
		);
	});
});
