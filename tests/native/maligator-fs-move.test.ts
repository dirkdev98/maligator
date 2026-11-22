import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

it("rejects an exclusive move onto an existing file and preserves both files", () => {
	const cwd = mkdtempSync(join(tmpdir(), "mal-fs-move-"));
	try {
		const source = join(cwd, "source.txt");
		const destination = join(cwd, "destination.txt");
		writeFileSync(source, "original source");
		writeFileSync(destination, "original destination");
		const binary = buildNativeBinary({
			fixture: "tests/local/maligator-fs-move.mjs",
			name: "maligator-fs-move",
			outDir: join(cwd, "out"),
		});

		expect(runToStdout(binary, { cwd }).trim()).toBe(
			"EEXIST rename source.txt destination.txt",
		);
		expect(readFileSync(source, "utf8")).toBe("original source");
		expect(readFileSync(destination, "utf8")).toBe("original destination");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
