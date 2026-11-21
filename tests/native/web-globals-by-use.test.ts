import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-globals-"));
// Runtime eval installs every web global up front, so these programs leave it off.
const config = resolveBuildConfig({
	engine: { eval: false },
	surface: { webPlatform: true, node: false },
});

function build(name: string, source: string): string {
	const fixture = path.join(outDir, `${name}.mjs`);
	writeFileSync(fixture, source);
	return buildNativeBinary({ fixture, name, mainFile: HOST_MAIN, outDir, config });
}

const groupInstallers = (binary: string) =>
	matchingNativeSymbols(binary, (symbol) =>
		[
			"mal_fetch_types_install",
			"mal_url_install",
			"mal_readable_stream_install",
		].includes(symbol),
	);

describe("web globals installed by use", () => {
	it("links no Fetch API, URL or streams into a program that names none of them", async () => {
		const binary = build("plain", 'console.log("plain");\n');
		expect(runToStdout(binary).trim()).toBe("plain");
		expect(await groupInstallers(binary)).toEqual([]);
	});

	it("gives a named class the classes it builds, without their globals", async () => {
		const binary = build(
			"response",
			`const body = new Response("hi").body;
const reader = body.getReader();
const { value } = await reader.read();
const encoded = new TextEncoderStream();
console.log(String.fromCharCode(...value), body.constructor.name, encoded.readable.constructor.name);
`,
		);
		for (const env of [{}, STRESS_ENV])
			expect(runToStdout(binary, { env }).trim()).toBe(
				"hi ReadableStream ReadableStream",
			);
		expect(await groupInstallers(binary)).toEqual([
			"mal_fetch_types_install",
			"mal_readable_stream_install",
			"mal_url_install",
		]);
	});

	it("installs every web global when the program reads the global object", () => {
		const binary = build(
			"escape",
			`const names = Object.getOwnPropertyNames(globalThis);
console.log(["Response", "URL", "ReadableStream", "structuredClone", "AbortController", "crypto"].every((name) => names.includes(name)));
`,
		);
		expect(runToStdout(binary).trim()).toBe("true");
	});
});
