import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalNodeHostModuleId,
	HOST_MODULES,
	supportedNodeBuiltinNames,
} from "../src/compiler/frontend/host-modules.ts";

export function generateNodeBuiltinModulesInclude(): string {
	return [
		"/* Generated from the compiler's supported host-module registry. */",
		...supportedNodeBuiltinNames().map((name) => `    ${JSON.stringify(name)},`),
		"",
	].join("\n");
}

export function generateNodeBuiltinInstallersInclude(): string {
	return [
		"/* Generated from the compiler's supported host-module registry. */",
		...[...HOST_MODULES.values()].map(
			({ id, installer }) =>
				`        {${JSON.stringify(id)}, ${installer}, ${canonicalNodeHostModuleId(id.slice(5)) === id ? "true" : "false"}},`,
		),
		"",
	].join("\n");
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const output = "runtime/src/generated/node_builtin_modules.inc";
	writeFileSync(output, generateNodeBuiltinModulesInclude());
	console.log(output);
	const installers = "runtime/src/generated/node_builtin_installers.inc";
	writeFileSync(installers, generateNodeBuiltinInstallersInclude());
	console.log(installers);
}
