import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fetch-body-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Request and Response Body streams", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/fetch_body.js",
			name: "fetch-body-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/fetch_body.js",
			name: "fetch-body-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("passes compiled under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("passes interpreted under GC stress", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});

it("serves a streamed response through the retained native body methods", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/builtin-member-stream-response.mjs",
		name: "builtin-member-stream-response",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("200 ok\n");
}, 120_000);

it("disturbs a byte-backed response without linking Web Streams", async () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fetch-byte-body.mjs",
		name: "fetch-byte-body",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("false,AB,true,TypeError\n");
	expect(
		await matchingNativeSymbols(
			binary,
			(name) => name === "mal_host_install_web_fetch_streams",
		),
	).toEqual([]);
}, 120_000);

it("a body getter materializes a consumed byte stream in the locked state", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fetch-byte-body-stream.mjs",
		name: "fetch-byte-body-stream",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("AB,true\n");
}, 120_000);

it("serializes JSON through a statically selected Response factory", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fetch-response-static-json.mjs",
		name: "fetch-response-static-json",
		outDir,
		config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
		production: true,
		toolchainBridge: false,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe('{"value":"é"}\n');
}, 120_000);
