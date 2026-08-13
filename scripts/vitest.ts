import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { CommandProgress } from "../src/command-progress.ts";

const arguments_ = process.argv.slice(2);
const progress = new CommandProgress("vitest");
progress.start(arguments_.length === 0 ? "watch all projects" : arguments_.join(" "));
progress.stage(1, 1, "run tests");

const result = spawnSync(path.resolve("node_modules/.bin/vitest"), arguments_, {
	stdio: "inherit",
	env: process.env,
});
if (result.error !== undefined) throw result.error;
if (result.status === 0) {
	progress.stagePassed(1, 1, "run tests");
	progress.complete();
} else {
	progress.stageFailed(1, 1, "run tests");
	progress.failed();
	if (result.signal !== null) process.kill(process.pid, result.signal);
	process.exitCode = result.status ?? 1;
}
