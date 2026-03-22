import { spawnSync } from "node:child_process";
import { doCCompile } from "./c-comp.ts";
import { makeUniqueNames } from "./naming.ts";
import { ProgramInformation } from "./program-info.ts";
import { doScopeAnalysis } from "./scope-analysis.ts";
import { doThreadAndEnvSlotAllocation } from "./slot-allocation.ts";
import { Transform } from "./transform.ts";

const program = new ProgramInformation({
	scriptEntrypoint: "./local2.js",
});

if (!process.argv.includes("--short")) {
	// program.loadModule("./local.js");
}

doScopeAnalysis(program);
makeUniqueNames(program);
doThreadAndEnvSlotAllocation(program);

const outputPath = doCCompile(new Transform(program).do());

// eslint-disable-next-line no-console
console.log(program.debug({ withBindings: true }));

console.log({ outputPath });

const result = spawnSync(outputPath, [], { stdio: "inherit" });

if (result.error) {
	throw result.error;
}

if (result.status !== 0) {
	throw new Error(`Program exited with status ${result.status ?? "unknown"}`);
}
