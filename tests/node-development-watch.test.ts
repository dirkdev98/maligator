import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { nodeDevelopmentWatchHost } from "../src/node-development-watch.ts";

test("filesystem events wake a retained development watcher", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-dev-watch-"));
	const file = path.join(directory, "entry.ts");
	writeFileSync(file, "export const revision = 0;\n");
	const handle = nodeDevelopmentWatchHost.create([file], []);
	const startedAt = Date.now();
	let changed = false;
	const change = setTimeout(() => {
		writeFileSync(file, "export const revision = 1;\n");
		changed = true;
	}, 20);
	try {
		do {
			await nodeDevelopmentWatchHost.wait(handle, 1000);
		} while (!changed);
		expect(readFileSync(file, "utf8")).toBe("export const revision = 1;\n");
		expect(Date.now() - startedAt).toBeLessThan(500);
	} finally {
		clearTimeout(change);
		nodeDevelopmentWatchHost.close(handle);
		rmSync(directory, { recursive: true, force: true });
	}
});
