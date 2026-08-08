import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { nodeDevelopmentWatchHost } from "../src/node-development-watch.ts";

test("filesystem events wake a retained development watcher", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-dev-watch-"));
	const file = path.join(directory, "entry.ts");
	writeFileSync(file, "export const revision = 0;\n");
	const handle = nodeDevelopmentWatchHost.create([file]);
	const startedAt = Date.now();
	try {
		setTimeout(() => writeFileSync(file, "export const revision = 1;\n"), 20);
		await nodeDevelopmentWatchHost.wait(handle, 1000);
		expect(Date.now() - startedAt).toBeLessThan(500);
	} finally {
		nodeDevelopmentWatchHost.close(handle);
	}
});
