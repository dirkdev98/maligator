#!/usr/bin/env node

import { developmentCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { createNodeCompilerService } from "./node-compiler-service.ts";
import { nodeDevelopmentProcessHost } from "./node-development-process.ts";
import { nodeDevelopmentWatchHost } from "./node-development-watch.ts";

const installation = developmentCompilerInstallation(import.meta.dirname);

await runCli(process.argv.slice(2), {
	stripTypes: stripCompactTypes,
	installation,
	...(process.argv[2] === "build"
		? { compiler: createNodeCompilerService(installation) }
		: {}),
	developmentProcesses: nodeDevelopmentProcessHost,
	developmentWatcher: nodeDevelopmentWatchHost,
	dependencyWorker: { tool: process.execPath, args: [import.meta.filename] },
});
