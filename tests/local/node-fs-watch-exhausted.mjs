import { mkdtempSync, writeFileSync, watch, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "mal-watch-exhausted-"));
try {
	for (let index = 0; index < 100; index++)
		writeFileSync(join(directory, `entry-${index}`), "data");
	let code;
	try {
		watch(directory).close();
	} catch (error) {
		code = error.code;
	}
	if (code !== "EMFILE")
		throw new Error(`expected a watch resource error, received ${code}`);
	console.log("watch resource error", code);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
