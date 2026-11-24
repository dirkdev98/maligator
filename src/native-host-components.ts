import { INTL_SERVICE_FEATURES } from "./build-flags.ts";
import type { NativeHostFeatures } from "./build-flags.ts";
import {
	INTRINSIC_INSTALLERS,
	INTL_INSTALLER,
	intlServiceInstaller,
} from "./compiler/frontend/engine-components.ts";
import {
	BUFFER_INSTALLER_SYMBOL,
	CRYPTO_DIGESTS_INSTALLER,
	FETCH_MEMBER_PROVIDERS,
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	HOST_PERSONALITY_INSTALLER,
	hostInstallerSymbol,
	HTTP_WITHOUT_WEBSOCKET_INSTALLER,
	imageUsesHost,
	NODE_CONSOLE_HOOKS_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_FETCH_BODY_BUFFER_INSTALLER,
	NODE_FETCH_BODY_BYTES_INSTALLER,
	NODE_FS_NAMED_INSTALLER,
	NODE_FS_READ_FILE_INSTALLER,
	NODE_FS_READ_STREAM_INSTALLER,
	NODE_PERSONALITY_INSTALLER,
	PERFORMANCE_INSTALLER_SYMBOL,
	PROCESS_ENV_INSTALLER,
	PROCESS_INSTALLER_SYMBOL,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	WEB_FETCH_INSTALLER,
	WEB_FETCH_STREAMS_INSTALLER,
	WORKER_THREADS_INSTALLER_SYMBOL,
	ZLIB_DECODERS_INSTALLER,
} from "./compiler/frontend/host-modules.ts";
import type { RuntimeImage } from "./compiler/target/runtime-image.ts";
import { PLATFORM_MODULES } from "./platform/catalog.ts";

const nodeInstallers = [...HOST_MODULES.values()];
const URL_PARSER_INSTALLERS = new Set([
	...FETCH_MEMBER_PROVIDERS,
	...[
		...nodeInstallers,
		...HOST_GLOBAL_INSTALLERS,
		...PLATFORM_MODULES.filter((module) => module.kind === "native"),
	]
		.filter(({ requiresUrlParser }) => requiresUrlParser)
		.map(({ installer }) => installer),
]);
URL_PARSER_INSTALLERS.add(NODE_FS_NAMED_INSTALLER);
// Worker wire programs install the full URL member lists.
URL_PARSER_INSTALLERS.add(WORKER_THREADS_INSTALLER_SYMBOL);
URL_PARSER_INSTALLERS.add(hostInstallerSymbol("node:cluster"));
URL_PARSER_INSTALLERS.add(hostInstallerSymbol("maligator:internal/workers"));

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
	NODE_FETCH_BODY_BUFFER_INSTALLER,
	NODE_FETCH_BODY_BYTES_INSTALLER,
	NODE_CONSOLE_HOOKS_INSTALLER,
	PROCESS_ENV_INSTALLER,
	BUFFER_INSTALLER_SYMBOL,
	WEB_FETCH_INSTALLER,
	WEB_FETCH_STREAMS_INSTALLER,
	"mal_host_install_web_events",
	"mal_host_install_web_url",
	"mal_host_install_maligator_assets",
	hostInstallerSymbol("maligator:internal/http"),
]);

const RUST_INTL_INSTALLERS = new Set([
	INTL_INSTALLER,
	...Object.keys(INTL_SERVICE_FEATURES).map(intlServiceInstaller),
]);

// These installers stay within the archive that omits rustls I/O, Argon2 and
// Temporal's upstream TZif provider. Unknown and name-resolved installers use
// the full archive.
const RUST_STD_FREE_INSTALLERS = new Set([
	...RING_FREE_INSTALLERS,
	...RUST_INTL_INSTALLERS,
	NODE_PERSONALITY_INSTALLER,
	PROCESS_INSTALLER_SYMBOL,
	PERFORMANCE_INSTALLER_SYMBOL,
	CRYPTO_DIGESTS_INSTALLER,
	HTTP_WITHOUT_WEBSOCKET_INSTALLER,
	ZLIB_DECODERS_INSTALLER,
	NODE_FS_READ_FILE_INSTALLER,
	NODE_FS_READ_STREAM_INSTALLER,
	NODE_FS_NAMED_INSTALLER,
	"mal_host_install_web_basics",
	"mal_host_install_web_streams",
	"mal_host_install_web_compression",
	...[
		"async_hooks",
		"buffer",
		"events",
		"net",
		"os",
		"path",
		"querystring",
		"stream",
		"string_decoder",
		"tty",
		"url",
		"util",
		"zlib",
	].map((id) => hostInstallerSymbol(`node:${id}`)),
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
		usesRustStd:
			resolvesInstallers ||
			images.some((installs) =>
				installs.some(({ installer }) => !RUST_STD_FREE_INSTALLERS.has(installer)),
			),
		usesRustIntl:
			resolvesInstallers ||
			images.some((installs) =>
				installs.some(({ installer }) => RUST_INTL_INSTALLERS.has(installer)),
			),
	};
}
