#!/usr/bin/env node

import { enableCompileCache } from "node:module";
import type { CommandContext } from "./cli-commands.ts";

// Enable Node's source and bytecode cache before it loads the compiler graph.
enableCompileCache();
const [
	{ developmentCompilerInstallation, runCli },
	{ stripCompactTypes },
	{ nodeDevelopmentProcessHost },
	{ nodeDevelopmentWatchHost },
] = await Promise.all([
	import("./cli-commands.ts"),
	import("./compiler/frontend/compact-type-strip.ts"),
	import("./node-development-process.ts"),
	import("./node-development-watch.ts"),
]);
const installation = developmentCompilerInstallation(import.meta.dirname);
const dependencyWorker = { tool: process.execPath, args: [import.meta.filename] };
const context: CommandContext = {
	stripTypes: stripCompactTypes,
	installation,
	developmentProcesses: nodeDevelopmentProcessHost,
	developmentWatcher: nodeDevelopmentWatchHost,
	dependencyWorker,
	compiler: undefined,
	rootCompiler: undefined,
	availableCompileConcurrency: undefined,
};

if (process.argv[2] === "build") {
	const [
		{ createNodeCompilerService },
		{ startNodeRootCompilation, validateRootInputs },
		{ workerBudget },
	] = await Promise.all([
		import("./node-compiler-service.ts"),
		import("./node-root-compiler.ts"),
		import("./worker-budget.ts"),
	]);
	context.compiler = createNodeCompilerService(installation, dependencyWorker);
	context.rootCompiler = {
		start: startNodeRootCompilation,
		validateInputs: validateRootInputs,
	};
	context.availableCompileConcurrency = workerBudget(process.env.MALIGATOR_WORKERS);
}
await runCli(process.argv.slice(2), context);
