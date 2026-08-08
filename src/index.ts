#!/usr/bin/env node

import { developmentCompilerInstallation, runCli } from "./cli-commands.ts";
import { nodeDevelopmentProcessHost } from "./node-development-process.ts";
import { nodeDevelopmentWatchHost } from "./node-development-watch.ts";
import { stripTypesWithTypeScript } from "./typescript-strip.ts";

await runCli(process.argv.slice(2), {
	stripTypes: stripTypesWithTypeScript,
	installation: developmentCompilerInstallation(import.meta.dirname),
	developmentProcesses: nodeDevelopmentProcessHost,
	developmentWatcher: nodeDevelopmentWatchHost,
});
