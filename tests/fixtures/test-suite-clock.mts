import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

const encodedStages = process.env.MAL_TEST_SUITE_FAKE_STAGES;
if (encodedStages === undefined) throw new Error("missing test-suite stage scenario");
const stages = JSON.parse(encodedStages) as Array<{
	durationMs: number;
	status: number;
}>;
let now = Date.now();
let index = 0;
mock.method(Date, "now", () => now);
mock.method(childProcess, "spawnSync", () => {
	const stage = stages[index++];
	if (stage === undefined) throw new Error("unexpected test-suite stage");
	now += stage.durationMs;
	return {
		pid: process.pid,
		output: [],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: stage.status,
		signal: null,
	};
});
syncBuiltinESMExports();
