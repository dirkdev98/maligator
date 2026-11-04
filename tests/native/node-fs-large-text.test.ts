import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

describe("large UTF-8 file reads", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-node-fs-large-text-"));
	const filename = join(directory, "records.json");
	const text = `${"x".repeat(64 * 1024 * 1024)}é😀`;
	const source = JSON.stringify({ text, count: 42 });
	writeFileSync(filename, source);
	let binaries: { compiled: string; interpreted: string };

	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/node-fs-large-text.mjs",
			name: "node-fs-large-text",
			mainFile: HOST_MAIN,
			outDir: directory,
			config: resolveBuildConfig({
				engine: { eval: false, regexp: false, intl: { enabled: false } },
				surface: { node: true },
			}),
		});
	});
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it.each(["compiled", "interpreted"] as const)(
		"reads and parses a file above the former 32 Mi UTF-16-unit limit in %s code",
		(backend) => {
			expect(
				runToStdout(binaries[backend], {
					env: { MAL_TEST_TEXT_FILE: filename, MAL_GC_VERIFY: "1" },
				}),
			).toBe(`${source.length} ${text.length} é😀 42\n`);
		},
	);
});
