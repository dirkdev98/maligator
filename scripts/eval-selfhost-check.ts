import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { compileSourceToBuffer } from "../src/compile.ts";

/**
 * Self-host validation (eval Phase 3). maligator compiles its own trimmed
 * compiler cone (compileSourceToBuffer + meriyah, type-stripped + bundled) to a
 * native binary; that binary, given a source string, must produce a
 * byte-identical wire buffer to the Node-hosted compiler. Compared via length +
 * Adler-32 + endpoint bytes (content-sensitive). Slow: it AOT-compiles the whole
 * compiler (~600+ functions), so this is a milestone gate, not a unit test.
 */

const SRC =
	"const x = 1 + 2 * 3; function add(a, b) { return a + b; } const y = add(x, 4); y;";

function digest(buf: Uint8Array | Array<number>): string {
	let a = 1;
	let b = 0;
	for (let i = 0; i < buf.length; i++) {
		a = (a + buf[i]!) % 65521;
		b = (b + a) % 65521;
	}
	return `${buf.length} ${a} ${b} ${buf[0]} ${buf[buf.length - 1]}`;
}

// Reference: the Node-hosted compiler.
const reference = digest(compileSourceToBuffer(SRC));

// Self-hosted: an entry that compiles SRC and prints the same digest, built by
// maligator (which strips + bundles the compiler cone) and run as a binary.
const tempDir = mkdtempSync(path.resolve(".selfhost-check-"));
const entry = path.join(tempDir, "entry.mts");
const config = path.join(tempDir, "maligator.build.json");

let out = "";
try {
	writeFileSync(
		entry,
		`import { compileSourceToBuffer } from "../src/compile.ts";
const buf = compileSourceToBuffer(${JSON.stringify(SRC)});
let a = 1, b = 0;
for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
console.log(buf.length + " " + a + " " + b + " " + buf[0] + " " + buf[buf.length - 1]);
`,
	);
	writeFileSync(
		config,
		JSON.stringify({
			engine: {
				eval: true,
				realms: true,
				regexp: true,
				intl: { enabled: true, features: [], languages: [] },
			},
			host: { scheduler: "single" },
			surface: { webPlatform: true, node: false, maligator: true },
		}),
	);
	const buildOutput = execFileSync(
		"node",
		["src/index.ts", "build", entry, "--name", "selfhost_check", "--config", config],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	const binaryMatch = buildOutput.match(/^Binary: (.+)$/m);
	if (binaryMatch === null) {
		throw new Error(`build produced no binary path:\n${buildOutput}`);
	}
	out = execFileSync(path.resolve(binaryMatch[1]!), { encoding: "utf8" }).trim();
} finally {
	// Not in a process.exit() path — that would skip this cleanup.
	rmSync(tempDir, { force: true, recursive: true });
}

if (out === reference) {
	console.log(`ok   self-hosted compiler matches Node: ${out}`);
} else {
	console.log(
		`FAIL self-hosted ${JSON.stringify(out)} != node ${JSON.stringify(reference)}`,
	);
	process.exit(1);
}
