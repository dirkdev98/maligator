import { ProgramInformation } from "./program-info.ts";
import { doScopeAnalysis } from "./scope-analysis.ts";

const program = new ProgramInformation();

if (!process.argv.includes("--short")) {
	program.loadModule("./local.js");
}
program.loadScript("./local2.js");

doScopeAnalysis(program);

// eslint-disable-next-line no-console
console.log(program.debug({ withBindings: true }));
