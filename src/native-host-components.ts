import {
	hostInstallerSymbol,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_FS_INSTALLER,
	WEB_FETCH_INSTALLER,
} from "./compiler/frontend/host-modules.ts";
import type { RuntimeImage } from "./compiler/target/runtime-image.ts";

const URL_PARSER_INSTALLERS = new Set([
	"mal_host_install_web_url",
	WEB_FETCH_INSTALLER,
	"mal_host_install_web_fetch_client",
	"mal_host_install_maligator_internal_fetch",
	"mal_host_install_maligator_internal_http",
	NODE_BUILTIN_LOADER_INSTALLER,
	hostInstallerSymbol("node:module"),
	hostInstallerSymbol("node:url"),
	hostInstallerSymbol("node:http"),
	hostInstallerSymbol("node:https"),
	// These installers also build Fetch objects or Node streams that use Fetch.
	hostInstallerSymbol("node:buffer"),
	hostInstallerSymbol("node:child_process"),
	hostInstallerSymbol("node:constants"),
	hostInstallerSymbol("node:crypto"),
	NODE_FS_INSTALLER,
	hostInstallerSymbol("node:net"),
	hostInstallerSymbol("node:stream"),
	hostInstallerSymbol("node:stream/consumers"),
	hostInstallerSymbol("node:stream/promises"),
	hostInstallerSymbol("node:tls"),
	hostInstallerSymbol("node:zlib"),
]);

export function imageUsesUrlParser(hostInstalls: RuntimeImage["hostInstalls"]): boolean {
	return hostInstalls.some(({ installer }) => URL_PARSER_INSTALLERS.has(installer));
}
