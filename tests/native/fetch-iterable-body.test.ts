import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";
const outDir = mkdtempSync(join(tmpdir(), "mal-fetch-iterable-body-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/fetch-iterable-body.mjs",
		name: "fetch-iterable-body",
		mainFile: HOST_MAIN,
		outDir,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"iterable Fetch bodies in %s code",
	(backend) => {
		it.each(["bytes", "cancel", "errors"])("handles %s", (selection) => {
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_ITERABLE_BODY_CASE: selection },
					}),
				).toContain("FETCH ITERABLE BODY PASS");
		});
	},
);

const closed = resolveBuildConfig({ engine: { eval: false, realms: false } });

it("consumes Node iterable chunks internally without installing Buffer", async () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fetch-iterable-no-buffer.mjs",
		name: "fetch-iterable-no-buffer",
		outDir,
		config: closed,
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_TEST_FETCH_CHUNK: "é" } })).toBe(
		"éABCD\n",
	);
	expect(
		await matchingNativeSymbols(binary, (name) => name === "mal_node_buffer_ensure"),
	).toEqual([]);
}, 120_000);

it("exposes converted chunks with Node's Buffer identity when read from a body", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fetch-iterable-buffer-brand.mjs",
		name: "fetch-iterable-buffer-brand",
		outDir,
		config: closed,
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_TEST_FETCH_CHUNK: "A" } })).toBe(
		"Buffer:A\n",
	);
}, 120_000);
