import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
if (mode === "ignore-termination") process.on("SIGTERM", () => {});
const root = tmpdir();
const nested = mkdtempSync(join(root, "fixture-"));
writeFileSync(join(nested, "generated.c"), "int main(void) { return 0; }");

let descendant: number | undefined;
if (mode === "descendant") {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	descendant = child.pid;
	child.unref();
}
process.stdout.write(
	`${JSON.stringify({
		root,
		nested,
		descendant,
		tmp: process.env.TMP,
		temp: process.env.TEMP,
	})}\n`,
);
if (mode === "wait" || mode === "ignore-termination") setInterval(() => {}, 1000);
else process.exitCode = mode === "failure" ? 7 : 0;
