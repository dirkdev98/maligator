#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/** @type {Record<string, string>} */
const packages = {
	"darwin-arm64": "@maligator/cli-darwin-arm64",
	"darwin-x64": "@maligator/cli-darwin-x64",
	"linux-arm64": "@maligator/cli-linux-arm64",
	"linux-x64": "@maligator/cli-linux-x64",
};

const platform = `${process.platform}-${process.arch}`;
const packageName = packages[platform];
if (packageName === undefined) {
	console.error(
		`Maligator does not provide a binary for ${platform}. ` +
			"Supported platforms are macOS and Linux on arm64 and x64.",
	);
	process.exit(1);
}

const require = createRequire(import.meta.url);
let binary;
try {
	binary = require.resolve(`${packageName}/bin/maligator`);
} catch {
	console.error(
		`The optional package ${packageName} is missing. ` +
			"Reinstall @maligator/cli with optional dependencies enabled.",
	);
	process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) {
	console.error(`Could not start Maligator: ${result.error.message}`);
	process.exit(1);
}
if (result.signal !== null) {
	process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
