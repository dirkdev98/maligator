import {
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	NODE_BUILTIN_LOADER_INSTALLER,
} from "./compiler/frontend/host-modules.ts";
import type { RuntimeImage } from "./compiler/target/runtime-image.ts";
import { PLATFORM_MODULES } from "./platform/catalog.ts";

const nodeInstallers = [...HOST_MODULES.values()];
const URL_PARSER_INSTALLERS = new Set(
	[
		...nodeInstallers,
		...HOST_GLOBAL_INSTALLERS,
		...PLATFORM_MODULES.filter((module) => module.kind === "native"),
	]
		.filter(({ requiresUrlParser }) => requiresUrlParser)
		.map(({ installer }) => installer),
);
if (nodeInstallers.some(({ requiresUrlParser }) => requiresUrlParser)) {
	URL_PARSER_INSTALLERS.add(NODE_BUILTIN_LOADER_INSTALLER);
}

export function imageUsesUrlParser(hostInstalls: RuntimeImage["hostInstalls"]): boolean {
	return hostInstalls.some(({ installer }) => URL_PARSER_INSTALLERS.has(installer));
}
