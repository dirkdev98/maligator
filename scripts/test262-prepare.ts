import { CommandProgress } from "../src/command-progress.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import { test262PrepareCheckout } from "../src/test262/files.ts";

const progress = new CommandProgress("test262:prepare");
progress.start("prepare the pinned full Test262 corpus cache");
progress.stage(1, 1, "fetch and validate corpus");

try {
	const revision = test262PrepareCheckout();
	progress.stagePassed(1, 1, "fetch and validate corpus", revision.slice(0, 12));
	progress.complete(`cached at ${TEST262_METADATA.path}`);
} catch (error) {
	progress.stageFailed(1, 1, "fetch and validate corpus");
	progress.failed();
	throw error;
}
