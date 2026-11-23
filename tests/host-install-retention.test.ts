import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseCliArgs } from "../src/cli.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	HOST_PERSONALITY_INSTALLER,
	HOST_PERSONALITY_INSTALLERS,
	hostInstallerSymbol,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_PERSONALITY_INSTALLER,
	PROCESS_INSTALLER_SYMBOL,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	ZLIB_DECODERS_INSTALLER,
} from "../src/compiler/frontend/host-modules.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import type { Execution } from "../src/platform/execution.ts";
import { executionTarget, resolveExecution } from "../src/platform/execution.ts";

const FETCH_INSTALLER = "mal_host_install_maligator_internal_fetch";
const HTTP_INSTALLER = "mal_host_install_maligator_internal_http";

const defaultConfig = resolveBuildConfig({});
const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selective host exports", () => {
	it("links decoder support for a static access on the default import", () => {
		const installs = manifest(
			`import zlib from "node:zlib"; globalThis.decode = zlib.gunzipSync;`,
			defaultConfig,
		);
		expect(installs.has(ZLIB_DECODERS_INSTALLER)).toBe(true);
		expect(installs.has(hostInstallerSymbol("node:zlib"))).toBe(false);
	});

	it.each([
		["an escaping namespace", "globalThis.zlib = zlib;"],
		["a computed property", "globalThis.decode = zlib[process.argv[2]];"],
		[
			"a replaced method",
			"zlib.gunzipSync = function () { return this; }; globalThis.zlib = zlib.gunzipSync();",
		],
		[
			"a computed builtin lookup",
			"globalThis.decode = zlib.gunzipSync; globalThis.module = process.getBuiltinModule(process.argv[2]);",
		],
	])("links the complete module for %s", (_name, statement) => {
		const installs = manifest(
			`import zlib from "node:zlib"; ${statement}`,
			defaultConfig,
		);
		expect(installs.has(hostInstallerSymbol("node:zlib"))).toBe(true);
	});
});

/** The install manifest of a whole-program build, as a production executable links it. */
function manifest(
	source: string,
	config: typeof defaultConfig,
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

/** The installers a program reaches, apart from the personality and Error hooks. */
function reachedInstallers(installs: Map<string, Array<string>>): Array<string> {
	return [...installs.keys()].filter(
		(installer) =>
			!HOST_PERSONALITY_INSTALLERS.includes(installer) &&
			installer !== NODE_ERROR_HOOKS_INSTALLER,
	);
}

function execution(args: Array<string>): Execution {
	const command = parseCliArgs(args);
	if (command.kind !== "run") throw new Error("Expected a run command");
	return resolveExecution(command, defaultConfig, {
		compiled: true,
		optimization: "full",
		target: executionTarget("aarch64-apple-darwin"),
	});
}

describe("language component retention", () => {
	it("omits both engines for a program that only writes to the console", () => {
		expect([...manifest(`console.log("hello");`, defaultConfig).keys()]).toEqual([]);
	});

	it.each([
		`console.log(typeof RegExp);`,
		`console.log(globalThis.RegExp.name);`,
		`console.log(/x/);`,
		`console.log("x".match("x"));`,
		`console.log("x".matchAll("x"));`,
		`console.log("x".search("x"));`,
		`console.log("x".replace(separator, "y"));`,
		`console.log("x".replaceAll(separator, "y"));`,
		`console.log("x".split(separator));`,
		`const replace = "x".replace; console.log(replace.call("x", separator, "y"));`,
	])("retains only RegExp for %s", (source) => {
		expect([...manifest(source, defaultConfig).keys()]).toEqual([REGEXP_INSTALLER]);
	});

	it.each([
		`console.log("e\\u0301".normalize());`,
		`console.log("e\\u0301"["normalize"]());`,
		`const { normalize } = String.prototype; console.log(normalize.call("e\\u0301"));`,
	])("retains only Unicode normalization for %s", (source) => {
		expect([...manifest(source, defaultConfig).keys()]).toEqual([
			UNICODE_NORMALIZATION_INSTALLER,
		]);
	});

	it.each([
		`console.log("x"[method]());`,
		`const method = "x"[name]; console.log(method.call("x"));`,
		`console.log(globalThis[name]);`,
		`console.log(Object.keys(globalThis));`,
		`console.log(Object.getOwnPropertyDescriptor(String.prototype, name));`,
		`console.log(Reflect.get(String.prototype, name));`,
	])("retains both engines for %s", (source) => {
		const installs = manifest(source, defaultConfig);
		expect(installs.has(REGEXP_INSTALLER)).toBe(true);
		expect(installs.has(UNICODE_NORMALIZATION_INSTALLER)).toBe(true);
	});

	it.each([
		`console.log("x".replace("x", "y"));`,
		`console.log("x".replaceAll("x", "y"));`,
		`console.log("x".split("x"));`,
		`console.log(("x"?.split)("x"));`,
	])("omits both engines for %s", (source) => {
		expect([...manifest(source, defaultConfig).keys()]).toEqual([]);
	});

	it("honors the RegExp opt-out during dynamic member retention", () => {
		const config = resolveBuildConfig({ engine: { regexp: false } });
		const installs = manifest(`console.log("x"[method]());`, config);
		expect(installs.has(REGEXP_INSTALLER)).toBe(false);
		expect(installs.has(UNICODE_NORMALIZATION_INSTALLER)).toBe(true);
	});

	it("retains the matcher for native terminal-control stripping", () => {
		const installs = manifest(
			`import { stripVTControlCharacters } from "node:util"; console.log(stripVTControlCharacters("text"));`,
			defaultConfig,
		);
		expect(installs.has(REGEXP_INSTALLER)).toBe(true);
	});
});

const servedSite = (watch: string) => `import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const site = embedDirectory("./public"${watch});
serve({ port: 0, fetch: serveAsset(site) });
`;

describe("maligator:http client retention", () => {
	it("links no fetch client for a server that never forwards", () => {
		const installs = manifest(
			`import { serve } from "maligator:http";\nserve({ port: 0, fetch: () => new Response("ok") });\n`,
			defaultConfig,
		);
		expect(installs.get(HTTP_INSTALLER)).toEqual(["listen"]);
		expect(installs.has(FETCH_INSTALLER)).toBe(false);
	});

	it("links no fetch client for served assets no declaration watches", () => {
		const installs = manifest(servedSite(""), defaultConfig, {
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
			defaultConfig,
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
			defaultConfig,
		);
		expect(installs.get(FETCH_INSTALLER)).toEqual(["fetch"]);
	});
});

describe("host surface installers", () => {
	it.each([
		["no remaining host reads", "", []],
		["a remaining web read", "setTimeout(() => {}, 1);", [HOST_PERSONALITY_INSTALLER]],
	])(
		"selects the personality after removing a Node read with %s",
		(_name, tail, expected) => {
			const installs = manifest(
				`import { execution } from "maligator:process";
import { join } from "node:path";
if (execution.production) console.log(join("unused"));
${tail}`,
				defaultConfig,
				{ execution: execution(["run", "main.mjs"]) },
			);
			expect([...installs.keys()]).toEqual(expected);
		},
	);

	it.each([
		["a web global", `globalThis.sink = new URL("https://example.com/").host;\n`],
		["a timer", `setTimeout(() => {}, 1);\n`],
	])("lists the web personality first for a program that uses %s", (_name, source) => {
		const installers = [...manifest(source, defaultConfig).keys()];
		expect(installers[0]).toBe(HOST_PERSONALITY_INSTALLER);
		expect(installers).not.toContain(NODE_PERSONALITY_INSTALLER);
		expect(installers).not.toContain(NODE_ERROR_HOOKS_INSTALLER);
	});

	it.each([
		["a Node global", `globalThis.sink = typeof process;\n`],
		["an immediate", `setImmediate(() => {});\n`],
		[
			"a node: module",
			`import { join } from "node:path";\nglobalThis.sink = join("a");\n`,
		],
		[
			"a web global next to a node: module",
			`import { join } from "node:path";\nglobalThis.sink = new URL(join("a"), "file:///");\n`,
		],
	])("lists the Node personality first for a program that uses %s", (_name, source) => {
		const installers = [...manifest(source, defaultConfig).keys()];
		expect(installers[0]).toBe(NODE_PERSONALITY_INSTALLER);
		expect(installers).not.toContain(HOST_PERSONALITY_INSTALLER);
		expect(installers).toContain(NODE_ERROR_HOOKS_INSTALLER);
	});

	it.each([
		"Error.captureStackTrace({});",
		"Error.prepareStackTrace = () => 'custom';",
		"globalThis.sink = Error.stackTraceLimit;",
	])("selects Node's Error hooks without a personality for %s", (source) => {
		expect([...manifest(source, defaultConfig).keys()]).toEqual([
			NODE_ERROR_HOOKS_INSTALLER,
		]);
	});
});

describe("process.getBuiltinModule retention", () => {
	const os = hostInstallerSymbol("node:os");

	it("installs only process for a program that reads static process members", () => {
		const installs = manifest(`process.stdout.write("hello\\n");\n`, defaultConfig);
		expect(reachedInstallers(installs)).toEqual([PROCESS_INSTALLER_SYMBOL]);
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
	])("installs only the builtin %s names", (_name, source) => {
		const installs = manifest(`${source}\n`, defaultConfig);
		expect(installs.has(os)).toBe(true);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(false);
	});

	it("installs nothing for feature detection of the loader", () => {
		const installs = manifest(
			`globalThis.sink = typeof process.getBuiltinModule === "function";\n`,
			defaultConfig,
		);
		expect(reachedInstallers(installs)).toEqual([PROCESS_INSTALLER_SYMBOL]);
	});

	it("installs nothing for a literal name Node does not load", () => {
		const installs = manifest(
			`globalThis.sink = process.getBuiltinModule("node:missing");\n`,
			defaultConfig,
		);
		expect(reachedInstallers(installs)).toEqual([PROCESS_INSTALLER_SYMBOL]);
	});

	it("keeps static destructuring of process selective", () => {
		const installs = manifest(
			`import process from "node:process";\nconst { stdout, env } = process;\nstdout.write(typeof env);\n`,
			defaultConfig,
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
	])("does not add builtin modules for %s", (_name, load) => {
		const installs = manifest(`globalThis.sink = ${load};\n`, defaultConfig);
		expect(installs.has(os)).toBe(false);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(false);
	});

	it("installs the loader when runtime eval can name any module", () => {
		const installs = manifest(
			`globalThis.sink = process.argv.length;\n`,
			resolveBuildConfig({ engine: { eval: true } }),
		);
		expect(installs.has(NODE_BUILTIN_LOADER_INSTALLER)).toBe(true);
	});
});
