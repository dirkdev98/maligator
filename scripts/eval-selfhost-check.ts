import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	compileSourceToBuffer,
	runtimeEvalOptimizationForSource,
} from "../src/compiler/pipeline/compile.ts";
import { scanLiteralTemplateSegment } from "../src/compiler/shared/literal-template-data.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";

/**
 * Self-host validation (eval Phase 3). maligator compiles its own trimmed
 * compiler cone (compileSourceToBuffer + meriyah, type-stripped + bundled) to a
 * native binary; that binary, given a source string and the runtime-eval
 * optimization profile, must produce the Node-hosted compiler's byte-identical
 * wire buffer. Compared via length + Adler-32 + endpoint bytes
 * (content-sensitive). Slow: it AOT-compiles the whole compiler (~600+
 * functions), so this is a milestone gate, not a unit test.
 */

const SRC = `$cfg={
entry: "tests/fixtures/express-5/assets-smoke.cjs",
outputName: "express-assets-real-world",
assets: {
public: {
type: "directory",
path: "tests/fixtures/express-5/public",
include: ["**/*"],
},
},
engine: { primordials: "mutable", intl: { enabled: false } },
surface: { webPlatform: true, node: true, maligator: true },
};`;

function digest(buf: Uint8Array | Array<number>): string {
	let a = 1;
	let b = 0;
	for (let i = 0; i < buf.length; i++) {
		a = (a + buf[i]!) % 65521;
		b = (b + a) % 65521;
	}
	return `${buf.length} ${a} ${b} ${buf[0]} ${buf[buf.length - 1]}`;
}

const referenceBuffer = compileSourceToBuffer(SRC, {
	optimization: runtimeEvalOptimizationForSource(SRC),
});
const reference = digest(referenceBuffer);
const referenceTemplate = JSON.stringify(
	deserializeRuntimeImage(referenceBuffer).literalTemplateData,
);
const referenceScan = JSON.stringify(
	scanLiteralTemplateSegment([9, 2, 10, 7, 0, 10, 8, 1], 0, "probe"),
);

// Self-hosted: an entry that compiles SRC and prints the same digest, built by
// maligator (which strips + bundles the compiler cone) and run as a binary.
const tempDir = mkdtempSync(path.resolve(".selfhost-check-"));
const entry = path.join(tempDir, "entry.mts");
const config = path.join(tempDir, "maligator.build.ts");

let out = "";
try {
	writeFileSync(
		entry,
		`import { compileSourceToBuffer, runtimeEvalOptimizationForSource } from "../src/compiler/pipeline/compile.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import { scanLiteralTemplateSegment } from "../src/compiler/shared/literal-template-data.ts";
const source = ${JSON.stringify(SRC)};
console.log(JSON.stringify(scanLiteralTemplateSegment([9, 2, 10, 7, 0, 10, 8, 1], 0, "probe")));
const buf = compileSourceToBuffer(source, { optimization: runtimeEvalOptimizationForSource(source) });
let a = 1, b = 0;
for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
console.log(buf.length + " " + a + " " + b + " " + buf[0] + " " + buf[buf.length - 1]);
console.log(JSON.stringify(deserializeRuntimeImage(buf).literalTemplateData));
`,
	);
	writeFileSync(
		config,
		`import { defineBuild } from "@maligator/cli";
export default defineBuild({
	engine: {
		eval: true,
		realms: true,
		regexp: true,
		intl: { enabled: true, features: [], languages: [] },
	},
	surface: { webPlatform: true, node: false, maligator: true },
});
`,
	);
	const buildOutput = execFileSync(
		"node",
		["src/index.ts", "build", entry, "--name", "selfhost_check", "--config", config],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	const binaryPath = buildOutput.trim();
	if (binaryPath === "") {
		throw new Error(`build produced no binary path:\n${buildOutput}`);
	}
	out = execFileSync(path.resolve(binaryPath), { encoding: "utf8" }).trim();
} finally {
	// Not in a process.exit() path — that would skip this cleanup.
	rmSync(tempDir, { force: true, recursive: true });
}

if (out === `${referenceScan}\n${reference}\n${referenceTemplate}`) {
	console.log(`ok   self-hosted compiler matches Node: ${out}`);
} else {
	console.log(
		`FAIL self-hosted ${JSON.stringify(out)} != node ${JSON.stringify(`${referenceScan}\n${reference}\n${referenceTemplate}`)}`,
	);
	process.exit(1);
}
