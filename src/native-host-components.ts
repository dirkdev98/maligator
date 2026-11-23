import type { NativeHostFeatures } from "./build-flags.ts";
import { INTRINSIC_INSTALLERS } from "./compiler/frontend/engine-components.ts";
import {
	BUFFER_INSTALLER_SYMBOL,
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	HOST_PERSONALITY_INSTALLER,
	HTTP_WITHOUT_WEBSOCKET_INSTALLER,
	hostInstallerSymbol,
	imageUsesHost,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_CONSOLE_HOOKS_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_FS_NAMED_INSTALLER,
	PROCESS_ENV_INSTALLER,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	WEB_FETCH_INSTALLER,
	WORKER_THREADS_INSTALLER_SYMBOL,
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
URL_PARSER_INSTALLERS.add(HTTP_WITHOUT_WEBSOCKET_INSTALLER);
URL_PARSER_INSTALLERS.add(NODE_FS_NAMED_INSTALLER);
// Worker wire programs install the full URL member lists.
URL_PARSER_INSTALLERS.add(WORKER_THREADS_INSTALLER_SYMBOL);
URL_PARSER_INSTALLERS.add(hostInstallerSymbol("node:cluster"));
URL_PARSER_INSTALLERS.add(hostInstallerSymbol("maligator:internal/workers"));
if (nodeInstallers.some(({ requiresUrlParser }) => requiresUrlParser)) {
	URL_PARSER_INSTALLERS.add(NODE_BUILTIN_LOADER_INSTALLER);
}

export function imageUsesUrlParser(hostInstalls: RuntimeImage["hostInstalls"]): boolean {
	return hostInstalls.some(({ installer }) => URL_PARSER_INSTALLERS.has(installer));
}

// An installer can link TLS or crypto through a native dependency even when
// JavaScript never imports either module (for example, node:constants).
const RING_FREE_INSTALLERS = new Set([
	...INTRINSIC_INSTALLERS,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	HOST_PERSONALITY_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_CONSOLE_HOOKS_INSTALLER,
	PROCESS_ENV_INSTALLER,
	BUFFER_INSTALLER_SYMBOL,
	WEB_FETCH_INSTALLER,
	"mal_host_install_web_events",
	"mal_host_install_web_url",
	"mal_host_install_maligator_assets",
	hostInstallerSymbol("maligator:internal/http"),
]);

export function resolveNativeHostFeatures(
	images: ReadonlyArray<RuntimeImage["hostInstalls"]>,
	resolvesInstallers = false,
): Required<NativeHostFeatures> {
	return {
		usesHost: resolvesInstallers || images.some(imageUsesHost),
		usesUrlParser: resolvesInstallers || images.some(imageUsesUrlParser),
		usesTlsOrCrypto:
			resolvesInstallers ||
			images.some((installs) =>
				installs.some(({ installer }) => !RING_FREE_INSTALLERS.has(installer)),
			),
	};
}
