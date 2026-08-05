#!/usr/bin/env node

import { developmentCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripTypesWithTypeScript } from "./typescript-strip.ts";

await runCli(process.argv.slice(2), {
	stripTypes: stripTypesWithTypeScript,
	installation: developmentCompilerInstallation(import.meta.dirname),
});
