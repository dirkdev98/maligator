import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HOST_MODULES } from "../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

// The host main always links the application API and the worker runtime it shuts down,
// so their installers' objects are present whatever the program imports.
const HOST_MAIN_INSTALLERS = [
	"mal_host_install_maligator",
	"mal_host_install_maligator_internal_workers",
];

describe("node host installer link retention", () => {
	let pathInstallers: Array<string>;
	let processInstallers: Array<string>;
	let deadPathInstallers: Array<string>;
	let bufferInstallers: Array<string>;
	let deadBufferInstallers: Array<string>;

	async function installers(fixture: string, name: string): Promise<Array<string>> {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-link-retention-"));
		try {
			return await matchingNativeSymbols(
				buildNativeBinary({
					fixture,
					name,
					mainFile: HOST_MAIN,
					outDir,
					nodeEnabled: true,
				}),
				(symbol, type) => type === "T" && symbol.startsWith("mal_host_install_"),
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	beforeAll(async () => {
		pathInstallers = await installers("tests/local/node-link-path.mjs", "node-link-path");
		processInstallers = await installers(
			"tests/local/node-link-process.mjs",
			"node-link-process",
		);
		deadPathInstallers = await installers(
			"tests/local/node-link-dead-path.mjs",
			"node-link-dead-path",
		);
		bufferInstallers = await installers(
			"tests/local/node-link-buffer.mjs",
			"node-link-buffer",
		);
		deadBufferInstallers = await installers(
			"tests/local/node-link-dead-buffer.mjs",
			"node-link-dead-buffer",
		);
	}, 1_200_000);

	it("retains only the path installer object for a path-only program", () => {
		expect(pathInstallers).toEqual([
			...HOST_MAIN_INSTALLERS,
			"mal_host_install_node_path",
			// All path installers belong to the same runtime archive member.
			"mal_host_install_node_path_posix",
			"mal_host_install_node_path_win32",
		]);
	});

	it("retains dynamic builtin installers when process.getBuiltinModule is available", () => {
		expect(processInstallers).toEqual(
			[
				...new Set([
					...HOST_MAIN_INSTALLERS,
					...[...HOST_MODULES.values()].map((module) => module.installer),
				]),
			].sort(),
		);
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(deadPathInstallers).toEqual(HOST_MAIN_INSTALLERS);
	});

	it("retains Buffer for a reachable free global", () => {
		expect(bufferInstallers).toEqual([
			...HOST_MAIN_INSTALLERS,
			"mal_host_install_node_buffer",
		]);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(deadBufferInstallers).toEqual(HOST_MAIN_INSTALLERS);
	});
});
