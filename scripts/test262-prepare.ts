import { CommandProgress } from "../src/command-progress.ts";
import { test262LoadInputIndex } from "../src/test262/cache.ts";
import { test262PrepareCheckout } from "../src/test262/files.ts";

const args = process.argv.slice(2);
if (
	args.length !== 0 &&
	(args.length !== 2 || args[0] !== "--corpus" || !/^[0-9a-f]{40}$/.test(args[1]!))
) {
	throw new Error("usage: test262:prepare [--corpus <full pinned commit>]");
}

const progress = new CommandProgress("test262:prepare");
progress.start("prepare the pinned full Test262 corpus cache");
progress.stage(1, 2, "fetch and validate corpus");

try {
	const corpus = test262PrepareCheckout({ revision: args[1] });
	progress.stagePassed(1, 2, "fetch and validate corpus", corpus.revision.slice(0, 12));
	progress.stage(2, 2, "index Test262 inputs");
	const index = test262LoadInputIndex(corpus);
	progress.stagePassed(
		2,
		2,
		"index Test262 inputs",
		`${index.files.length} files · ${index.cache}`,
	);
	progress.complete(`cached at ${corpus.path}`);
} catch (error) {
	progress.failed();
	throw error;
}
