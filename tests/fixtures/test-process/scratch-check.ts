import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

export function checkScratch(): void {
	const report = process.env.MAL_TEST_SCRATCH_REPORT!;
	const directory = tmpdir();
	const marker = join(directory, "generated.c");
	const previous = existsSync(report)
		? (JSON.parse(readFileSync(report, "utf8")) as Array<string>)
		: [];

	test("owns scratch separately from the preceding file", () => {
		for (const entry of previous) {
			expect(entry).not.toBe(directory);
			expect(existsSync(entry)).toBe(process.env.MAL_TEST_KEEP_ARTIFACTS === "1");
		}
		expect(process.env.TMP).toBe(directory);
		expect(process.env.TEMP).toBe(directory);
		expect(process.env.MAL_TEST_ARTIFACT_DIRECTORY).toBe(directory);
		writeFileSync(marker, "int main(void) { return 0; }");
	});

	afterAll(() => {
		expect(existsSync(marker)).toBe(true);
		writeFileSync(report, JSON.stringify([...previous, directory]));
	});
}
