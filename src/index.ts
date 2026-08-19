#!/usr/bin/env node

import { developmentCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";
import { nodeDevelopmentProcessHost } from "./node-development-process.ts";
import { nodeDevelopmentWatchHost } from "./node-development-watch.ts";

await runCli(process.argv.slice(2), {
	stripTypes: stripCompactTypes,
	installation: developmentCompilerInstallation(import.meta.dirname),
	developmentProcesses: nodeDevelopmentProcessHost,
	developmentWatcher: nodeDevelopmentWatchHost,
	dependencyWorker: { tool: process.execPath, args: [import.meta.filename] },
});
