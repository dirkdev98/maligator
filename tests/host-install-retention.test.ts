import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseCliArgs } from "../src/cli.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	hostInstallerSymbol,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_INSTALLED_BUILTINS_INSTALLER,
	PROCESS_INSTALLER_SYMBOL,
} from "../src/compiler/frontend/host-modules.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import type { Execution } from "../src/platform/execution.ts";
import { executionTarget, resolveExecution } from "../src/platform/execution.ts";

const FETCH_INSTALLER = "mal_host_install_maligator_internal_fetch";
const HTTP_INSTALLER = "mal_host_install_maligator_internal_http";

const web = resolveBuildConfig({ surface: { webPlatform: true } });
const node = resolveBuildConfig({ surface: { node: true } });
const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The install manifest of a whole-program build, as a production executable links it. */
function manifest(
	source: string,
	config: typeof web,
	options: { execution?: Execution; files?: Record<string, string> } = {},
): Map<string, Array<string>> {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-install-retention-"));
	roots.push(root);
	for (const [file, contents] of Object.entries(options.files ?? {})) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), contents);
	}
	const entry = path.join(root, "main.mjs");
	writeFileSync(entry, source);
	const image = compileEntrypoint(entry, {
		buildConfig: config,
		stripTypes: stripCompactTypes,
		...(options.execution === undefined ? {} : { execution: options.execution }),
	});
	return new Map(
		image.runtime.hostInstalls.map((install) => [
			install.installer,
			install.exports.map((entry) => entry.name),
		]),
	);
}

function execution(args: Array<string>): Execution {
	const command = parseCliArgs(args);
	if (command.kind !== "run") throw new Error("Expected a run command");
	return resolveExecution(command, web, {
		compiled: true,
		optimization: "full",
		target: executionTarget("aarch64-apple-darwin"),
	});
}

const servedSite = (watch: string) => `import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const site = embedDirectory("./public"${watch});
serve({ port: 0, fetch: serveAsset(site) });
`;

describe("maligator:http client retention", () => {
	it("links no fetch client for a server that never forwards", () => {
		const installs = manifest(
			`import { serve } from "maligator:http";\nserve({ port: 0, fetch: () => new Response("ok") });\n`,
			web,
		);
		expect(installs.get(HTTP_INSTALLER)).toEqual(["listen"]);
		expect(installs.has(FETCH_INSTALLER)).toBe(false);
	});

	it("links no fetch client for served assets no declaration watches", () => {
		const installs = manifest(servedSite(""), web, {
			files: { "public/index.html": "hi\n" },
		});
		expect(installs.get(HTTP_INSTALLER)).not.toContain("assetProxy");
		expect(installs.has(FETCH_INSTALLER)).toBe(false);
	});

	it("keeps forwarding for a declaration served from its watcher", () => {
		const installs = manifest(
			servedSite(
				`, { watch: { command: ["true"], url: "http://127.0.0.1:1/" }, use: { run: "watch" } }`,
			),
			web,
			{
				execution: execution(["run", "main.mjs"]),
				files: { "public/index.html": "hi\n" },
			},
		);
		expect(installs.get(HTTP_INSTALLER)).toContain("assetProxy");
		expect(installs.get(FETCH_INSTALLER)).toEqual(["fetch"]);
	});

	it("links the fetch client a program imports from maligator:http", () => {
		const installs = manifest(
			`import { fetch } from "maligator:http";\nglobalThis.sink = await fetch("data:,x");\n`,
			web,
		);
		expect(installs.get(FETCH_INSTALLER)).toEqual(["fetch"]);
	});
});

describe("process.getBuiltinModule retention", () => {
	const os = hostInstallerSymbol("node:os");

	it("installs only process for a program that reads static process members", () => {
		const installs = manifest(`process.stdout.write("hello\\n");\n`, node);
		expect([...installs.keys()]).toEqual([PROCESS_INSTALLER_SYMBOL]);
	});

	it.each([
		["a literal name", `globalThis.sink = process.getBuiltinModule("os");`],
		[
			"a prefixed template literal",
			"globalThis.sink = process.getBuiltinModule?.(`node:os`);",
		],
		[
			"a call through the imported process",
			`import process from "node:process";\nglobalThis.sink = process.getBuiltinModule("os");`,
		],
		[
			"a call of the named export",
			`import { getBuiltinModule } from "node:process";\nglobalThis.sink = getBuiltinModule("os");`,
		],
	])("installs the module %s names and the lookup, not the loader", (_name, source) => {
		const installs = manifest(`${source}\n`, node);
		expect(installs.has(os)).toBe(true);
		expect(installs.has(NODE_INSTALLED_BUILTINS_INSTALLER)).toBe(true);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(false);
	});

	it("installs nothing for feature detection of the loader", () => {
		const installs = manifest(
			`globalThis.sink = typeof process.getBuiltinModule === "function";\n`,
			node,
		);
		expect([...installs.keys()]).toEqual([PROCESS_INSTALLER_SYMBOL]);
	});

	it("installs nothing for a literal name Node does not load", () => {
		const installs = manifest(
			`globalThis.sink = process.getBuiltinModule("node:missing");\n`,
			node,
		);
		expect([...installs.keys()]).toEqual([PROCESS_INSTALLER_SYMBOL]);
	});

	it("keeps static destructuring of process selective", () => {
		const installs = manifest(
			`import process from "node:process";\nconst { stdout, env } = process;\nstdout.write(typeof env);\n`,
			node,
		);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(false);
	});

	it.each([
		["a computed name", `process.getBuiltinModule(process.argv[2])`],
		["a detached loader", `[process.getBuiltinModule][0]("node:os")`],
		["a computed process member", `process[process.argv[2]]("node:os")`],
		["an escaping process object", `Reflect.get(process, "getBuiltinModule")("os")`],
		[
			"a destructured loader",
			`(() => { const { getBuiltinModule } = process; return getBuiltinModule("os"); })()`,
		],
		["a computed global object read", `globalThis[process.argv[2]]`],
	])("installs the loader for %s", (_name, load) => {
		const installs = manifest(`globalThis.sink = ${load};\n`, node);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(true);
	});

	it("installs the loader when runtime eval can name any module", () => {
		const installs = manifest(
			`globalThis.sink = process.argv.length;\n`,
			resolveBuildConfig({ surface: { node: true }, engine: { eval: true } }),
		);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(true);
	});
});
