import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const TEXT = "node:zlib round trip; ".repeat(300);
const DECODERS: Record<string, (input: Buffer) => Buffer> = {
	deflate: (input) => zlib.inflateSync(input),
	gzip: (input) => zlib.gunzipSync(input),
	deflateRaw: (input) => zlib.inflateRawSync(input),
	brotliCompress: (input) => zlib.brotliDecompressSync(input),
};

/** Compressed bytes legitimately differ from Node's zlib, so blobs are checked by decoding them with Node. */
function withoutBlobs(output: string): string {
	const kept: Array<string> = [];
	for (const line of output.trim().split("\n")) {
		const blob = /^blob (\w+) (\S+)$/.exec(line);
		if (blob === null) {
			kept.push(line);
			continue;
		}
		const decode = DECODERS[blob[1] ?? ""];
		expect(decode, blob[1]).toBeDefined();
		expect(decode?.(Buffer.from(blob[2] ?? "", "base64")).toString()).toBe(TEXT);
		kept.push(`blob ${blob[1]}`);
	}
	return kept.join("\n");
}

it("compresses and decompresses node:zlib formats in sync, callback and stream forms like Node", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-zlib-compress-test-"));
	const fixture = "tests/local/node-zlib-compress.mjs";
	try {
		const expected = withoutBlobs(
			execFileSync(process.execPath, ["--no-deprecation", fixture], { encoding: "utf8" }),
		);
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-zlib-compress",
			outDir: directory,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				expect(withoutBlobs(runToStdout(binary, { env }))).toBe(expected);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
