import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const keys = ["TMPDIR", "TMP", "TEMP", "MAL_TEST_ARTIFACT_DIRECTORY"] as const;
const previous = keys.map((key) => process.env[key]);
const directory = mkdtempSync(join(tmpdir(), "native-file-"));
for (const key of keys) process.env[key] = directory;

// Setup hooks unwind after the file's hooks, while its worker can still run more files.
afterAll(() => {
	try {
		if (process.env.MAL_TEST_KEEP_ARTIFACTS !== "1")
			rmSync(directory, { recursive: true, force: true });
	} finally {
		for (const [index, key] of keys.entries()) {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
