import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mal-fs-promises-watch-"));
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 10_000);
let renamed = false;
// Repeat the expected rename so losing the first event cannot strand the iterator.
const timer = setInterval(() => {
	const replacement = path.join(dir, "next.txt");
	writeFileSync(replacement, "x");
	renameSync(replacement, path.join(dir, "f0.txt"));
}, 50);
try {
	const iterator = watch(dir, { signal: controller.signal });
	for await (const event of iterator) {
		if (event.eventType === "rename" && event.filename === "f0.txt") {
			renamed = true;
			console.log("promises event", event.eventType, event.filename);
			controller.abort();
		}
	}
} catch (error) {
	if (error.code !== "ABORT_ERR") throw error;
	console.log("promises abort", error.name, error.code);
} finally {
	clearTimeout(deadline);
	clearInterval(timer);
	rmSync(dir, { recursive: true, force: true });
}
if (!renamed) throw new Error("Timed out waiting for a promises.watch notification");
