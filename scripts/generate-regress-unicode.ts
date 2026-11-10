import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const input = process.argv[2];
if (input === undefined || process.argv.length !== 3) {
	throw new Error(
		"Usage: node scripts/generate-regress-unicode.ts <Unicode-18.0.0-directory>",
	);
}
const generator = path.resolve(
	import.meta.dirname,
	"../runtime/rust/vendor/regress/gen-unicode",
);
const hashes = JSON.parse(
	readFileSync(path.join(generator, "inputs.json"), "utf8"),
) as Record<string, string>;
for (const [name, expected] of Object.entries(hashes)) {
	const actual = createHash("sha256")
		.update(readFileSync(path.resolve(input, name)))
		.digest("hex");
	if (actual !== expected) throw new Error(`Unicode 18.0.0 source mismatch: ${name}`);
}

const target = mkdtempSync(path.join(os.tmpdir(), "mal-regress-unicode-"));
try {
	const cargo = execFileSync("rustup", ["which", "cargo"], {
		cwd: generator,
		encoding: "utf8",
	}).trim();
	execFileSync(cargo, ["run", "--locked", "--", path.resolve(input)], {
		cwd: generator,
		stdio: "inherit",
		env: {
			...process.env,
			PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}`,
			CARGO_TARGET_DIR: target,
		},
	});
} finally {
	rmSync(target, { recursive: true, force: true });
}
