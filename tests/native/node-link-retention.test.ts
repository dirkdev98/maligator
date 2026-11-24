import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	BUFFER_INSTALLER_SYMBOL,
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_PERSONALITY_INSTALLER,
} from "../../src/compiler/frontend/host-modules.ts";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { matchingNativeSymbols } from "../helpers/native-symbols.ts";

const MODULE_INSTALLERS = new Set(
	[...HOST_MODULES.values()].map((module) => module.installer),
);
const BUILTIN_REGISTRY_LOOKUP = "mal_node_module_get_builtin";
// A program that reads a Node module or global lists the Node personality and hooks.
// They follow the reads lowering sees, so they stay when optimization drops the read.
const NODE_HOST = [NODE_PERSONALITY_INSTALLER, NODE_ERROR_HOOKS_INSTALLER];

function runSelectedHostFixture(file: string, env: NodeJS.ProcessEnv = {}): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-node-selected-exports-"));
	const fixture = `tests/local/${file}`;
	try {
		const binary = buildNativeBinary({
			fixture,
			name: path.parse(file).name,
			outDir: directory,
			mainFile: HOST_MAIN,
			toolchainBridge: false,
			config: resolveBuildConfig({}),
		});
		return runToStdout(binary, { env: { ...STRESS_ENV, ...env } });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it.each([
	["selected exports", "node-selected-host-exports.cjs"],
	["alias identity and reflected exports", "node-selected-host-alias.mjs"],
	["the complete module for a destructured loader", "node-selected-host-loader.cjs"],
	["the public URL export order", "node-selected-host-url-order.cjs"],
])("preserves %s under native host installation", (_label, file) => {
	const stdout = execFileSync(process.execPath, [`tests/local/${file}`], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1" },
	});
	expect(runSelectedHostFixture(file)).toBe(stdout);
});

it("exposes complete builtins to opaque runtime lookup", () => {
	expect(
		runSelectedHostFixture("node-selected-host-runtime-lookup.cjs", {
			MAL_HOST_LOADER_KEY: "getBuiltinModule",
		}),
	).toBe("string undefined undefined true\n");
});

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
			BUFFER_INSTALLER_SYMBOL,
			...HOST_GLOBAL_INSTALLERS.map(({ installer }) => installer),
			NODE_BUILTIN_LOADER_INSTALLER,
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
		expect(processInstallers).not.toContain(BUILTIN_REGISTRY_LOOKUP);
	});

	it("links only the module a literal getBuiltinModule call names", () => {
		expect(literalBuiltinInstallers).toEqual(
			withInstallers(processInstallers, "mal_host_install_node_os"),
		);
	});

	it("omits the registry when getBuiltinModule receives a computed name", () => {
		const builtinInstallers = new Set([
			...MODULE_INSTALLERS,
			NODE_BUILTIN_LOADER_INSTALLER,
			BUILTIN_REGISTRY_LOOKUP,
		]);
		expect(
			computedBuiltinInstallers.filter(
				(name) => builtinInstallers.has(name) && !processInstallers.includes(name),
			),
		).toEqual([]);
	});

	it("keeps literal CommonJS builtin loading selective", () => {
		expect(literalCjsInstallers).toEqual(pathInstallers);
	});

	it("omits builtin installers for a computed CommonJS require", () => {
		const builtinInstallers = new Set([
			...MODULE_INSTALLERS,
			NODE_BUILTIN_LOADER_INSTALLER,
			BUILTIN_REGISTRY_LOOKUP,
		]);
		expect(computedCjsInstallers.filter((name) => builtinInstallers.has(name))).toEqual(
			[],
		);
	});

	it("links no Node host when the path import's only read is optimized away", () => {
		expect(deadPathInstallers).toEqual(hostMainInstallers);
	});

	it.runIf(process.platform === "darwin")(
		"links EventEmitter without Node streams for a named file watcher",
		async () => {
			const watchInstallers = await installers(
				"tests/local/node-fs-watch-exhausted.mjs",
				"node-link-fs-watch",
			);
			expect(watchInstallers).toContain("mal_host_install_node_events");
			expect(watchInstallers).not.toContain("mal_host_install_node_stream");
		},
	);

	it("links the Buffer global without installing the node:buffer module", () => {
		expect(bufferInstallers).toContain(BUFFER_INSTALLER_SYMBOL);
		if (process.platform === "linux") {
			// ELF development builds may retain both Buffer installers in one text section.
			expect(
				bufferInstallers.filter(
					(installer) =>
						MODULE_INSTALLERS.has(installer) &&
						installer !== "mal_host_install_node_buffer",
				),
			).toEqual([]);
			expect(bufferInstallers).not.toContain(BUILTIN_REGISTRY_LOOKUP);
			return;
		}
		expect(bufferInstallers).toEqual(
			withInstallers(hostMainInstallers, BUFFER_INSTALLER_SYMBOL, ...NODE_HOST),
		);
	});

	it("links no Node host when the Buffer import's only read is optimized away", () => {
		expect(deadBufferInstallers).toEqual(hostMainInstallers);
	});
});
