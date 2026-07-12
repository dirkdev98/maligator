import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypointToBuffer } from "../src/compile-program.ts";
import { buildNativeBinary } from "../src/test-harness.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

const fixture = path.resolve("tests/fixtures/selfhost-frontend/entry.mts");
const outDir = path.resolve(".cache/selfhost-frontend");
const nativeOutput = path.join(outDir, "native.malw");
mkdirSync(outDir, { recursive: true });
rmSync(nativeOutput, { force: true });

const config = resolveBuildConfig({
	engine: { eval: false, regexp: true, intl: { enabled: false } },
	surface: { webPlatform: false, node: true },
});

const reference = compileEntrypointToBuffer(fixture, {
	buildConfig: config,
	stripTypes: stripTypesWithTypeScript,
});
const binary = buildNativeBinary({
	fixture: "src/selfhost-frontend-entry.mts",
	name: "selfhost-frontend",
	outDir,
	config,
});

// Compiled process.argv inserts "<compiled>" at index 1, so the entry reads
// these two OS arguments at the Node-compatible script positions 2 and 3.
execFileSync(binary, [fixture, nativeOutput], { stdio: "inherit" });
const actual = readFileSync(nativeOutput);

if (
	actual.length !== reference.length ||
	!actual.every((byte, i) => byte === reference[i])
) {
	throw new Error(
		`self-hosted front end differs: native=${actual.length} bytes, node=${reference.length} bytes`,
	);
}
console.log(`ok   self-hosted front end matches Node (${actual.length} bytes)`);
