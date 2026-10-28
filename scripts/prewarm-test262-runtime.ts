import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandProgress } from "../src/command-progress.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";

const progress = new CommandProgress("test262-runtime");
progress.start("prepare the configured Test262 runtime");
const temporary = mkdtempSync(join(tmpdir(), "mal-test262-prewarm-"));

try {
	// Runtime paths are captured when its module loads; harness objects are disposable.
	TEST262_METADATA.reportPath = join(temporary, "reports");
	TEST262_METADATA.workPath = join(temporary, "work");
	const { test262PrepareBuild } = await import("../src/test262/runtime.ts");
	test262PrepareBuild();
	progress.complete("native artifacts cached");
} catch (error) {
	progress.failed();
	throw error;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
