import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectEmbeddedAssets } from "../../src/assets.ts";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { canonicalEmbedDeclaration } from "../../src/compiler/frontend/embed-declarations.ts";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-embedded-assets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sourceTree = path.join(root, "source");
const baseDirectory = path.join(root, "materialized");
const entry = path.join(root, "main.mjs");

describe("embedded maligator:assets in a built executable", () => {
	let binary: string;
	let directoryHash: string;

	beforeAll(() => {
		mkdirSync(path.join(sourceTree, "nested"), { recursive: true });
		writeFileSync(path.join(sourceTree, "hello.txt"), "﻿hello asset\n");
		writeFileSync(path.join(sourceTree, "config.json"), '{"answer":42}');
		writeFileSync(path.join(sourceTree, ".hidden"), "hidden");
		writeFileSync(
			path.join(sourceTree, "nested", "bytes.bin"),
			new Uint8Array([0, 1, 2, 255]),
		);
		writeFileSync(
			entry,
			`import { embedDirectory, embedFile } from "maligator:assets";
const base = ${JSON.stringify(baseDirectory)};
const tree = embedDirectory("./source");
const hello = embedFile("./source/hello.txt");
const lines = [];
lines.push([hello.path, hello.size, hello.type, hello.digest].join(" "));
lines.push(JSON.stringify(hello.text()));
const bytes = hello.bytes();
let immutable = false;
try { bytes[0] = 1; immutable = bytes[0] !== 1; } catch { immutable = true; }
lines.push([bytes.length, bytes.buffer.immutable === true || immutable, Object.isFrozen(hello)].join(" "));
lines.push(String(tree.get("config.json").json().answer));
lines.push(tree.files().map((file) => file.path + ":" + file.size + ":" + file.type).join(","));
lines.push([tree.get("missing"), tree.get("../hello.txt"), tree.get(".hidden")].map(String).join(","));
const nested = tree.get("nested/bytes.bin");
lines.push(Array.from(nested.bytes()).join(","));
const materialized = tree.materialize({ baseDirectory: base });
lines.push(materialized);
lines.push(String(materialized === tree.materialize({ baseDirectory: base })));
lines.push(tree.materialize());
lines.push(nested.materialize({ baseDirectory: base }));
lines.push(hello.materialize({ baseDirectory: base }));
const { text } = hello;
lines.push(JSON.stringify(text()));
console.log(lines.join("\\n"));
`,
		);
		directoryHash = collectEmbeddedAssets([
			canonicalEmbedDeclaration(
				{ kind: "directory", specifier: sourceTree },
				sourceTree,
				() => root,
			),
		])[0]!.hash;
		binary = buildNativeBinary({
			fixture: entry,
			name: "embedded-assets",
			outDir: path.join(root, "out"),
			config: resolveBuildConfig({}),
		});
		// The executable must not reach back to the files it embedded.
		rmSync(sourceTree, { recursive: true });
	});

	function assertRun(env?: NodeJS.ProcessEnv): void {
		const lines = runToStdout(binary, { env }).trim().split("\n");
		const base = realpathSync(baseDirectory);
		const hello = "\uFEFFhello asset\n";
		const helloSize = Buffer.byteLength(hello);
		expect(lines.slice(0, 7)).toEqual([
			`hello.txt ${helloSize} text/plain; charset=utf-8 ${hash("sha256", hello, "hex")}`,
			JSON.stringify("hello asset\n"),
			`${helloSize} true true`,
			"42",
			`config.json:13:application/json,hello.txt:${helloSize}:text/plain; charset=utf-8,nested/bytes.bin:4:application/octet-stream`,
			"undefined,undefined,undefined",
			"0,1,2,255",
		]);
		expect(lines[7]).toBe(path.join(base, `${directoryHash}-2`));
		expect(lines[8]).toBe("true");
		expect(path.dirname(lines[9]!)).toBe(realpathSync(os.tmpdir()));
		expect(lines[10]).toBe(path.join(lines[7]!, "nested", "bytes.bin"));
		expect(readFileSync(lines[10]!)).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(readFileSync(lines[11]!, "utf8")).toBe("﻿hello asset\n");
		expect(readFileSync(path.join(lines[7]!, ".maligator-asset-complete"), "utf8")).toBe(
			`${directoryHash}-2`,
		);
		expect(lines[12]).toBe(JSON.stringify("hello asset\n"));
	}

	it("serves the embedded copies after the sources are gone", () => {
		assertRun();
	});

	it("keeps detached handle methods alive under GC stress", () => {
		assertRun(STRESS_ENV);
	});
});
