import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	HOST_MODULES,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_INSTALLED_BUILTINS_INSTALLER,
} from "../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

const MODULE_INSTALLERS = new Set(
	[...HOST_MODULES.values()].map((module) => module.installer),
);

function withInstallers(base: ReadonlyArray<string>, ...added: Array<string>) {
	return [...new Set([...base, ...added])].sort();
}

describe("node host installer link retention", () => {
	let hostMainInstallers: Array<string>;
	let pathInstallers: Array<string>;
	let processInstallers: Array<string>;
	let literalBuiltinInstallers: Array<string>;
	let computedBuiltinInstallers: Array<string>;
	let deadPathInstallers: Array<string>;
	let bufferInstallers: Array<string>;
	let deadBufferInstallers: Array<string>;
	let literalCjsInstallers: Array<string>;
	let computedCjsInstallers: Array<string>;

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
					// Production builds disable eval. Runtime eval keeps every global group
					// and builtin that code compiled at run time could name.
					evalEnabled: false,
				}),
				(symbol, type) => type === "T" && symbol.startsWith("mal_host_install_"),
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	beforeAll(async () => {
		// These links keep whole archive members, so the host main brings the installer
		// objects its application API and worker runtime reference, whatever the
		// program imports. Every other set is this one plus what the program uses.
		hostMainInstallers = await installers(
			"tests/local/node-link-empty.mjs",
			"node-link-empty",
		);
		pathInstallers = await installers("tests/local/node-link-path.mjs", "node-link-path");
		processInstallers = await installers(
			"tests/local/node-link-process.mjs",
			"node-link-process",
		);
		literalBuiltinInstallers = await installers(
			"tests/local/node-link-builtin-literal.mjs",
			"node-link-builtin-literal",
		);
		computedBuiltinInstallers = await installers(
			"tests/local/node-link-builtin-computed.mjs",
			"node-link-builtin-computed",
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
		literalCjsInstallers = await installers(
			"tests/local/node-link-cjs-path.cjs",
			"node-link-cjs-path",
		);
		computedCjsInstallers = await installers(
			"tests/local/node-link-cjs-computed.cjs",
			"node-link-cjs-computed",
		);
	}, 1_200_000);

	it("links no node module installer into the host main of a program that imports none", () => {
		expect(hostMainInstallers).toEqual(
			expect.arrayContaining([
				"mal_host_install_maligator",
				"mal_host_install_maligator_internal_workers",
			]),
		);
		expect(
			hostMainInstallers.filter((installer) => MODULE_INSTALLERS.has(installer)),
		).toEqual([]);
	});

	it("retains only the path installer object for a path-only program", () => {
		expect(pathInstallers).toEqual(
			withInstallers(
				hostMainInstallers,
				"mal_host_install_node_path",
				// All path installers belong to the same runtime archive member.
				"mal_host_install_node_path_posix",
				"mal_host_install_node_path_win32",
			),
		);
	});

	it("links no builtin a process-only program cannot load", () => {
		expect(processInstallers).toContain("mal_host_install_process");
		expect(processInstallers).not.toContain("mal_host_install_node_os");
		expect(processInstallers).not.toContain("mal_host_install_node_sqlite");
		expect(processInstallers).not.toContain(NODE_BUILTIN_LOADER_INSTALLER);
		expect(processInstallers).not.toContain(NODE_INSTALLED_BUILTINS_INSTALLER);
	});

	it("links only the module a literal getBuiltinModule call names", () => {
		expect(literalBuiltinInstallers).toEqual(
			withInstallers(
				processInstallers,
				NODE_INSTALLED_BUILTINS_INSTALLER,
				"mal_host_install_node_os",
			),
		);
	});

	it("retains every builtin installer for a computed getBuiltinModule name", () => {
		expect(computedBuiltinInstallers).toEqual(
			expect.arrayContaining([NODE_BUILTIN_LOADER_INSTALLER, ...MODULE_INSTALLERS]),
		);
	});

	it("keeps literal CommonJS builtin loading selective", () => {
		expect(literalCjsInstallers).toEqual(pathInstallers);
	});

	it("retains the builtin registry for a materialized CommonJS require", () => {
		expect(computedCjsInstallers).toEqual(
			expect.arrayContaining([NODE_BUILTIN_LOADER_INSTALLER, ...MODULE_INSTALLERS]),
		);
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(deadPathInstallers).toEqual(hostMainInstallers);
	});

	it("retains Buffer for a reachable free global", () => {
		expect(bufferInstallers).toEqual(
			withInstallers(hostMainInstallers, "mal_host_install_node_buffer"),
		);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(deadBufferInstallers).toEqual(hostMainInstallers);
	});
});
