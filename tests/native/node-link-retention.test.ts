import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_INSTALLED_BUILTINS_INSTALLER,
	NODE_PERSONALITY_INSTALLER,
} from "../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

const MODULE_INSTALLERS = new Set(
	[...HOST_MODULES.values()].map((module) => module.installer),
);
const BUILTIN_REGISTRY_LOOKUP = "mal_node_module_get_builtin";
// A program that reads a Node module or global lists the Node personality and hooks.
// They follow the reads lowering sees, so they stay when optimization drops the read.
const NODE_HOST = [NODE_PERSONALITY_INSTALLER, NODE_ERROR_HOOKS_INSTALLER];

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
				(symbol, type) =>
					type === "T" &&
					(symbol.startsWith("mal_host_install_") || symbol === BUILTIN_REGISTRY_LOOKUP),
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	beforeAll(async () => {
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

	it("omits optional installers from an empty Node program", () => {
		const optionalInstallers = new Set([
			...MODULE_INSTALLERS,
			...HOST_GLOBAL_INSTALLERS.map(({ installer }) => installer),
			NODE_BUILTIN_LOADER_INSTALLER,
			NODE_INSTALLED_BUILTINS_INSTALLER,
			BUILTIN_REGISTRY_LOOKUP,
			"mal_host_install_maligator_internal_workers",
		]);
		if (process.platform === "linux") {
			// ELF development builds retain the worker and event installers in
			// the same text sections as the host's worker and event machinery.
			optionalInstallers.delete("mal_host_install_maligator_internal_workers");
			optionalInstallers.delete("mal_host_install_web_events");
			optionalInstallers.delete("mal_host_install_web_node_events");
		}
		expect(hostMainInstallers).toContain("mal_host_install_maligator");
		expect(
			hostMainInstallers.filter((installer) => optionalInstallers.has(installer)),
		).toEqual([]);
	});

	it("keeps a path-only program selective", () => {
		// The three path installers share one ELF text section.
		const variants = new Set([
			"mal_host_install_node_path_posix",
			"mal_host_install_node_path_win32",
		]);
		const retained =
			process.platform === "linux"
				? pathInstallers.filter((installer) => !variants.has(installer))
				: pathInstallers;
		expect(retained).toEqual(
			withInstallers(hostMainInstallers, "mal_host_install_node_path", ...NODE_HOST),
		);
	});

	it("links no builtin a process-only program cannot load", () => {
		expect(processInstallers).toContain("mal_host_install_process");
		expect(processInstallers).not.toContain("mal_host_install_node_os");
		expect(processInstallers).not.toContain("mal_host_install_node_sqlite");
		expect(processInstallers).not.toContain(NODE_BUILTIN_LOADER_INSTALLER);
		expect(processInstallers).not.toContain(NODE_INSTALLED_BUILTINS_INSTALLER);
		expect(processInstallers).not.toContain(BUILTIN_REGISTRY_LOOKUP);
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
			expect.arrayContaining([
				NODE_BUILTIN_LOADER_INSTALLER,
				BUILTIN_REGISTRY_LOOKUP,
				...MODULE_INSTALLERS,
			]),
		);
	});

	it("keeps literal CommonJS builtin loading selective", () => {
		expect(literalCjsInstallers).toEqual(pathInstallers);
	});

	it("retains the builtin registry for a materialized CommonJS require", () => {
		expect(computedCjsInstallers).toEqual(expect.arrayContaining([...MODULE_INSTALLERS]));
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(deadPathInstallers).toEqual(withInstallers(hostMainInstallers, ...NODE_HOST));
	});

	it("retains Buffer for a reachable free global", () => {
		if (process.platform === "linux") {
			// Buffer's web dependencies retain their installer sections on ELF.
			expect(
				bufferInstallers.filter((installer) => MODULE_INSTALLERS.has(installer)),
			).toEqual(["mal_host_install_node_buffer"]);
			expect(bufferInstallers).not.toContain(BUILTIN_REGISTRY_LOOKUP);
			return;
		}
		expect(bufferInstallers).toEqual(
			withInstallers(hostMainInstallers, "mal_host_install_node_buffer", ...NODE_HOST),
		);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(deadBufferInstallers).toEqual(
			withInstallers(hostMainInstallers, ...NODE_HOST),
		);
	});
});
