import { makeUniqueNames } from "./naming.ts";
import { ProgramInformation } from "./program-info.ts";
import { doScopeAnalysis } from "./scope-analysis.ts";

const program = new ProgramInformation({
	scriptEntrypoint: "./local2.js",
});

if (!process.argv.includes("--short")) {
	program.loadModule("./local.js");
}

doScopeAnalysis(program);
makeUniqueNames(program);

// eslint-disable-next-line no-console
console.log(program.debug({ withBindings: false }));
