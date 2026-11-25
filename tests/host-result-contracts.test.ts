import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
} from "../src/compiler/frontend/host-modules.ts";
import {
	buildModuleGraph,
	ModuleParseCache,
} from "../src/compiler/frontend/module-graph.ts";
import type { BuildModuleGraphOptions } from "../src/compiler/frontend/module-graph.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	BUFFER_STRING_ENCODINGS,
	CAPTURED_HOST_RESULTS,
	GLOBAL_HOST_FUNCTION_RESULTS,
	CRYPTO_STREAM_DELEGATES,
	DISK_HANDLE_EXPORTS,
	EMBEDDED_ASSET_RESULTS,
	PLATFORM_OBJECT_RESULTS,
	HOST_RESULT_CONTRACTS,
	NODE_FILE_HANDLE_RESULTS,
	GLOBAL_HOST_CONSTRUCTORS,
	HOST_OBJECT_RESULTS,
} from "../src/compiler/shared/host-result-contracts.ts";
import type { HostObjectKind } from "../src/compiler/shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import { primordialNode } from "../src/compiler/shared/primordial-catalog.ts";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

const namedImports = `
	import { readFileSync as readSync } from "node:fs";
	import { readFile as readAsync } from "node:fs/promises";
	import { open } from "node:fs/promises";
	import { basename } from "node:path/posix";
	import { uptime } from "node:os";
`;

function inspectHostCall(
	expression: string,
	type: string,
	setup = "",
	imports = namedImports,
	virtualModules?: BuildModuleGraphOptions["virtualModules"],
	inspected = "inspect",
) {
	const directory = mkdtempSync(join(tmpdir(), "mal-host-result-"));
	try {
		const entry = join(directory, "entry.mjs");
		writeFileSync(join(directory, "asset.txt"), "embedded text");
		writeFileSync(
			entry,
			`
			${imports}
			async function inspect(path, options) {
				${setup}
				const result = ${expression};
				return typeof result === ${JSON.stringify(type)};
			}
			globalThis.inspect = inspect;
		`,
		);
		const graph = buildModuleGraph(entry, {
			stripTypes: stripCompactTypes,
			virtualModules,
		});
		const config = resolveBuildConfig({ engine: { primordials: "locked", eval: false } });
		let operations: ReturnType<typeof coreOperations> | undefined;
		compileSemanticProgramToProgramImage(runSemanticAnalysisForGraph(graph), {
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(config),
				certifyProgramClosure(graph, config, {
					relocatableArtifact: false,
					hostWireSplicing: false,
				}),
			),
			afterCoreOptimization(program) {
				operations = coreOperations(coreFunctionNamed(program, inspected)!);
			},
		});
		return operations!.map(({ opcode }) => opcode);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it("uses the controller supplied to a private Web Stream start hook", () => {
	const operations = inspectHostCall(
		`new ReadableStream({ start(controller) {
			globalThis.output = typeof controller.enqueue('chunk') === 'undefined';
		} })`,
		"object",
		"",
		"",
		undefined,
		"start",
	);
	expect(operations).toContain("call");
	expect(operations).not.toContain("typeofCompare");
});

it("keeps the controller observation when another hook can retrieve the callback", () => {
	const operations = inspectHostCall(
		`new ReadableStream({
			start(controller) { return typeof controller.enqueue('chunk') === 'undefined'; },
			cancel() { globalThis.observer = this.start; }
		})`,
		"object",
		"",
		"",
		undefined,
		"start",
	);
	expect(operations).toContain("typeofCompare");
});

it.each([
	["process.hrtime.bigint()", "bigint", ""],
	["process.memoryUsage.rss()", "number", ""],
	["process.sourceMapsEnabled", "boolean", ""],
	["punycode.ucs2.encode([65])", "string", 'import punycode from "node:punycode";'],
	["v8.startupSnapshot.isBuildingSnapshot()", "boolean", 'import v8 from "node:v8";'],
	[
		"moduleApi.registerHooks({}).deregister()",
		"undefined",
		'import moduleApi from "node:module";',
	],
	[
		"execSync('echo example', {encoding: 'utf8'})",
		"string",
		'import { execSync } from "node:child_process";',
	],
	[
		"(await exec[promisify.custom]('echo example')).stdout",
		"string",
		'import { exec } from "node:child_process"; import { promisify } from "node:util";',
	],
	[
		"(await promisify(exec)('echo example', { encoding: 'buffer' })).stdout.readUInt8(0)",
		"number",
		'import { exec } from "node:child_process"; import { promisify } from "node:util";',
	],
])("uses the captured callable or getter reached by %s", (expression, type, imports) => {
	expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
});

it.each([
	["readSync(path, 'utf8')", "string"],
	["readSync(path, null)", "string"],
	["readSync(path)", "string"],
	["readSync(path, options)", "number"],
	["readSync(path, { encoding: 'utf8' })", "string"],
	["await readAsync(path, 'utf8')", "string"],
	["await readAsync(path)", "string"],
	["readSync(path).readUInt8(0)", "number"],
	["(await readAsync(path)).readUInt8(0)", "number"],
	["await readAsync(path, options)", "number"],
	["await (await open(path)).readFile('utf8')", "string"],
	["await (await open(path)).readFile()", "string"],
	["basename(path)", "string"],
	["uptime()", "number"],
])("folds an observation of %s using its normal result contract", (expression, type) => {
	const operations = inspectHostCall(expression, type);
	expect(operations).toContain("call");
	expect(operations).not.toContain("typeofCompare");
	if (expression.startsWith("await ")) expect(operations).toContain("await");
});

it("does not use mutable encoding options after scheduling a file read", () => {
	const operations = inspectHostCall(
		"await promise",
		"string",
		`
		const opts = { encoding: 'utf8' };
		const promise = readAsync(path, opts);
		opts.encoding = null;
	`,
	);
	expect(operations).toContain("typeofCompare");
});

it("keeps the successful result specific to each call of a rethrowing async wrapper", () => {
	const operations = inspectHostCall(
		"await settle(() => readAsync(path, 'utf8'))",
		"string",
		`async function settle(operation) {
			try { return await operation(); }
			catch (error) { throw error; }
		}
		await settle(() => uptime());`,
	);
	expect(operations).toContain("await");
	expect(operations).not.toContain("typeofCompare");
});

it.each([
	[
		"(await pause(1, 'tick'))",
		"string",
		'import { setTimeout as pause } from "node:timers/promises";',
	],
	["hash('sha256', 'input')", "string", 'import { hash } from "node:crypto";'],
	["isatty(0)", "boolean", 'import { isatty } from "node:tty";'],
	[
		"getCipherInfo('unrecognized')",
		"number",
		'import { getCipherInfo } from "node:crypto";',
	],
])("uses the native contract of %s", (expression, type, imports) => {
	expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
});

it("keeps the observation of a replaced FileHandle method", () => {
	const operations = inspectHostCall(
		"await handle.readFile('utf8')",
		"string",
		`
		const handle = await open(path);
		handle.readFile = async () => 42;
	`,
	);
	expect(operations).toContain("typeofCompare");
});

it("does not apply the filesystem result contract to a virtual module override", () => {
	const operations = inspectHostCall(
		"file(options)",
		"number",
		"",
		'import { file } from "maligator:fs";',
		new Map([
			[
				"maligator:fs",
				{ source: "export function file(value) { return value; }", platform: true },
			],
		]),
	);
	expect(operations).toContain("typeofCompare");
});

it("does not reuse an embedding's replacement filesystem parse for the canonical module", () => {
	const parseCache = new ModuleParseCache();
	const entry = join(tmpdir(), "mal-canonical-filesystem-entry.mjs");
	const options = {
		entrySource: `import { file } from "maligator:fs"; file("example.txt");`,
		parseCache,
	};
	const replacement = buildModuleGraph(entry, {
		...options,
		stripTypes: () => "export function file(value) { return value; }",
	});
	expect(
		replacement.modules.get("maligator:fs")?.canonicalPlatformSource,
	).toBeUndefined();
	const canonical = buildModuleGraph(entry, {
		...options,
		stripTypes: stripCompactTypes,
	});
	const filesystem = canonical.modules.get("maligator:fs")!;
	expect(filesystem.canonicalPlatformSource).toBe("maligator:fs");
	expect(filesystem.dependencies.map(({ specifier }) => specifier)).toContain(
		"maligator:internal/fs",
	);
});

it.each([
	["await file(path).text()", "string"],
	["await file(path).bytes()", "string"],
	["await file(path).writer().write('text')", "number"],
])("uses the successful result of %s through the source module", (expression, type) => {
	const operations = inspectHostCall(
		expression,
		type,
		"",
		'import { file } from "maligator:fs";',
	);
	expect(operations).toContain("await");
	expect(operations).not.toContain("typeofCompare");
});

it.each([
	[
		"serve({ fetch: () => new Response('hello') }).port",
		"number",
		'import { serve } from "maligator:http";',
	],
	[
		"await serve({ fetch: () => new Response('hello') }).close()",
		"undefined",
		'import { serve } from "maligator:http";',
	],
	[
		"await (await fetch('data:text/plain,hello')).text()",
		"string",
		'import { fetch } from "maligator:http";',
	],
	[
		"createPool(options).stats().active",
		"number",
		'import { createPool } from "maligator:workers";',
	],
	[
		"transfer(options, []).transferList",
		"string",
		'import { transfer } from "maligator:workers";',
	],
])("propagates %s through the packaged source module", (expression, type, imports) => {
	expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
});

it.each([
	'new Response("body")',
	'new Request("https://example.test", { method: "POST", body: "body" })',
	'new Blob(["body"])',
	'(await fetch("data:text/plain,body"))',
])("uses the installed body reader for %s", (receiver) => {
	const operations = inspectHostCall(`await ${receiver}.text()`, "string", "", "");
	expect(operations).toContain("await");
	expect(operations).not.toContain("typeofCompare");
});

it("keeps the result observation after a Web prototype override", () => {
	const operations = inspectHostCall(
		'await new Response("body").text()',
		"string",
		"Response.prototype.text = async () => 42;",
		"",
	);
	expect(operations).toContain("typeofCompare");
});

it.each([
	["Object.setPrototypeOf", ""],
	["_extend", 'import { _extend } from "node:util";'],
])(
	"keeps the result observation when a host callback can modify the receiver through %s",
	(callback, imports) => {
		const operations = inspectHostCall(
			"await response.text()",
			"number",
			`const response = new Response("body");
		setTimeout(${callback}, 0, response, { text: () => 42 });
		await pause(10);`,
			`${imports}\nimport { setTimeout as pause } from "node:timers/promises";`,
		);
		expect(operations).toContain("typeofCompare");
	},
);

it.each([
	["new Response().status", "number"],
	["new Response().ok", "boolean"],
	["new Headers().get('missing')", "number"],
	["await Response.json({ answer: 42 }).text()", "string"],
	["await new Request('https://example.test').clone().text()", "string"],
])("propagates the result of %s", (expression, type) => {
	expect(inspectHostCall(expression, type, "", "")).not.toContain("typeofCompare");
});

it.each([
	["embedFile('./asset.txt').size", "number", ""],
	["readText()", "string", "const readText = embedFile('./asset.txt').text;"],
])("uses frozen asset member identity for %s", (expression, type, setup) => {
	const imports = 'import { embedFile } from "maligator:assets";';
	expect(inspectHostCall(expression, type, setup, imports)).not.toContain(
		"typeofCompare",
	);
});

it("accounts for all installed callable module exports", () => {
	const catalog = getPrimordialCatalog();
	const installers = new Set([
		...[...HOST_MODULES.values()].map(({ installer }) => installer),
		...PLATFORM_MODULES.flatMap((module) =>
			module.kind === "native" ? [module.installer] : [],
		),
	]);
	const missing = catalog.roots.flatMap(([root, node]) => {
		const colon = root.indexOf(":");
		const installer = root.slice(0, colon);
		const contracts = HOST_RESULT_CONTRACTS.get(installer);
		const name = root.slice(colon + 1);
		return installers.has(installer) &&
			typeof node === "number" &&
			(catalog.nodes[node]![2] & 2) !== 0 &&
			!contracts?.has(name)
			? [root]
			: [];
	});
	expect(missing).toEqual([]);
});

it("selects the string digest encodings implemented by Buffer", () => {
	const source = readFileSync(
		new URL("../runtime/src/runtime/node_buffer.c", import.meta.url),
		"utf8",
	);
	const native = source.match(/static bool mal_buffer_encoding_named\([\s\S]*?\n\}/)?.[0];
	expect(native).toBeDefined();
	const encodings = [
		...native!.matchAll(/mal_buffer_ascii_equal_ci\(string, "([^"]+)"\)/g),
	];
	expect(BUFFER_STRING_ENCODINGS).toEqual(new Set(encodings.map((match) => match[1])));
});

it("accounts for the installed crypto stream delegation methods", () => {
	const source = readFileSync(
		new URL("../runtime/src/runtime/node_crypto.c", import.meta.url),
		"utf8",
	);
	const delegates = source.match(
		/CRYPTO_LAZY_STREAM_METHODS\[\] = \{([\s\S]*?)\n\};/,
	)?.[1];
	expect(delegates).toBeDefined();
	expect(
		new Set([...delegates!.matchAll(/"([^"]+)"/g)].map((match) => match[1])),
	).toEqual(new Set(CRYPTO_STREAM_DELEGATES));
});

it("accounts for methods and getters installed on Node FileHandle objects", () => {
	const source = readFileSync(
		new URL("../runtime/src/runtime/node_fs.c", import.meta.url),
		"utf8",
	);
	const operations = source.match(
		/file_handle_operations\[\] = \{([\s\S]*?)\n {4}\};/,
	)?.[1];
	const allocation = source.match(
		/static MalValue node_fs_open_promise_task\([\s\S]*?\n\}/,
	)?.[0];
	const getters = [
		...source.matchAll(
			/mal_intrinsic_define_getter\(vm, file_handle_proto,\s*\(const byte \*\) "([^"]+)"/g,
		),
	];
	expect(operations).toBeDefined();
	expect(allocation).toBeDefined();
	const methods = [
		...[...operations!.matchAll(/^\s*\{"([^"]+)"/gm)],
		...[
			...allocation!.matchAll(
				/mal_intrinsic_define_data\(vm, &handle->object,\s*\(const byte \*\) "([^"]+)"/g,
			),
		],
	].map((match) => match[1]!);
	expect(new Set(methods)).toEqual(new Set(NODE_FILE_HANDLE_RESULTS.methods.keys()));
	expect(new Set(getters.map((match) => match[1]!))).toEqual(
		new Set(NODE_FILE_HANDLE_RESULTS.properties.keys()),
	);
});

it("accounts for members installed on embedded asset handles", () => {
	const source = readFileSync(
		new URL("../runtime/src/runtime/maligator_assets.c", import.meta.url),
		"utf8",
	);
	for (const kind of ["file", "directory"] as const) {
		const functionStart = source.indexOf(`static MalValue asset_${kind}_handle(`);
		expect(functionStart).toBeGreaterThanOrEqual(0);
		const build = source.slice(functionStart, source.indexOf("\n}", functionStart));
		const installed = [
			...build.matchAll(
				/(?:asset_define_(?:method|getter)|mal_intrinsic_define_data)\(vm, handle, (?:\(const byte \*\) )?"([^"]+)"/g,
			),
		];
		const { properties, methods } = EMBEDDED_ASSET_RESULTS[kind];
		expect(new Set(installed.map((match) => match[1]))).toEqual(
			new Set([...properties.keys(), ...methods.keys()]),
		);
	}
});

it("accounts for the exported filesystem wrappers and their handle classes", () => {
	const url = new URL("../src/fs/runtime.ts", import.meta.url);
	const { ast } = parseModule(stripCompactTypes(readFileSync(url, "utf8"), url.pathname));
	const exports = new Set<string>();
	const handles = new Map<string, Set<string>>();
	for (const node of ast.body) {
		if (node.type === "ExportNamedDeclaration") {
			const { declaration } = node;
			if (
				declaration?.type === "FunctionDeclaration" ||
				declaration?.type === "ClassDeclaration"
			)
				exports.add(declaration.id!.name);
		}
		if (node.type === "ClassDeclaration" && node.id !== null) {
			const members = new Set<string>();
			for (const element of node.body.body) {
				if (
					"key" in element &&
					element.key?.type === "Identifier" &&
					element.key.name !== "constructor"
				)
					members.add(element.key.name);
			}
			handles.set(node.id.name, members);
		}
	}
	expect(exports).toEqual(new Set(DISK_HANDLE_EXPORTS.keys()));
	for (const kind of ["file", "directory"] as const) {
		const members = PLATFORM_OBJECT_RESULTS[kind];
		expect(
			handles.get(kind === "file" ? "DiskFileHandle" : "DiskDirectoryHandle"),
		).toEqual(new Set([...members.methods.keys(), ...members.properties.keys()]));
	}
});

it("accounts for the installed host constructors, methods, and accessors", () => {
	const { nodes, roots } = getPrimordialCatalog();
	const inventory = new Map<string, HostObjectKind>([
		...GLOBAL_HOST_CONSTRUCTORS.map((name) => [`globalThis.${name}`, name] as const),
		...(
			[
				"Crypto",
				"SubtleCrypto",
				"Performance",
				"PerformanceEntry",
				"MessagePort",
				"ReadableByteStreamController",
				"ReadableStreamDefaultController",
				"ReadableStreamBYOBRequest",
				"TransformStreamDefaultController",
				"WritableStreamDefaultController",
			] as const
		).map((name) => [`globalThis.${name}`, name] as const),
		["%MAL_INTRINSIC_NODE_FS_MODULE%.Dir", "Dir"],
		["%MAL_INTRINSIC_NODE_SQLITE_MODULE%.StatementSync", "StatementSync"],
		["%MAL_INTRINSIC_NODE_CRYPTO_MODULE%.KeyObject", "AsymmetricKeyObject"],
	]);
	const missing: Array<string> = [];
	const checked = new Set<string>();
	const fromRoot = (root: string) => {
		const colon = root.indexOf(":");
		return HOST_RESULT_CONTRACTS.get(root.slice(0, colon))?.get(root.slice(colon + 1));
	};
	const installedContract = (nodeIndex: number) => {
		const node = nodes[nodeIndex]!;
		return (
			CAPTURED_HOST_RESULTS.get(node[0]) ??
			node[5].map(fromRoot).find((value) => value !== undefined)
		);
	};
	for (const [root, index] of roots) {
		if (typeof index !== "number" || (nodes[index]![2] & 2) === 0) continue;
		const contract = fromRoot(root);
		if (contract?.kind === "return" && contract.value.hostConstructor !== undefined) {
			inventory.set(nodes[index]![0], contract.value.hostConstructor);
		}
	}
	for (const { globals } of HOST_GLOBAL_INSTALLERS) {
		for (const name of globals) {
			const identity = `globalThis.${name}`;
			const node = primordialNode(identity);
			if (node === undefined || (node[2] & 2) === 0) continue;
			if (
				name !== "fetch" &&
				!GLOBAL_HOST_FUNCTION_RESULTS.has(name) &&
				!inventory.has(identity) &&
				![
					"CryptoKey",
					"PerformanceMark",
					"PerformanceMeasure",
					"PerformanceObserverEntryList",
					"PerformanceResourceTiming",
				].includes(name)
			) {
				missing.push(identity);
			}
		}
	}
	for (const [owner, kind] of inventory) {
		const constructor = primordialNode(owner);
		expect(constructor, owner).toBeDefined();
		const prototype = constructor![4].find(([name]) => name === "prototype")?.[2];
		check(
			constructor!,
			HOST_OBJECT_RESULTS.statics[kind],
			HOST_OBJECT_RESULTS.staticProperties[kind],
		);
		if (typeof prototype === "number")
			check(
				nodes[prototype]!,
				HOST_OBJECT_RESULTS.methods[kind],
				HOST_OBJECT_RESULTS.properties[kind],
			);
	}
	for (const [owner, kind] of [
		["%MAL_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE%", "HeadersIterator"],
		["%MAL_INTRINSIC_FORM_DATA_ITERATOR_PROTOTYPE%", "FormDataIterator"],
		["%MAL_INTRINSIC_URL_SEARCH_PARAMS_ITERATOR_PROTOTYPE%", "URLSearchParamsIterator"],
	] as const)
		check(
			primordialNode(owner)!,
			HOST_OBJECT_RESULTS.methods[kind],
			HOST_OBJECT_RESULTS.properties[kind],
		);
	expect(missing.sort()).toEqual([]);

	function check(
		node: (typeof nodes)[number],
		methods: ReadonlyMap<string, unknown> | undefined,
		properties: ReadonlyMap<string, unknown> | undefined,
	) {
		const [owner, , , , members] = node;
		if (checked.has(owner)) return;
		checked.add(owner);
		for (const [key, , value, getter] of members) {
			if (key === "constructor") continue;
			const member =
				typeof key === "string"
					? key
					: (nodes[key[0]]![0].match(/\[\[SymbolKey:[^\]]+\]\]$/)?.[0] ??
						`[${nodes[key[0]]![0].replaceAll("%", "")}]`);
			if (getter >= 0 && !properties?.has(member) && !installedContract(getter))
				missing.push(`${owner}.${member} getter`);
			if (typeof value !== "number" || (nodes[value]![2] & 2) === 0) continue;
			if (!methods?.has(member) && !installedContract(value))
				missing.push(`${owner}.${member}`);
		}
	}
});

it.each([
	["new TextDecoder().decode()", "string", ""],
	[
		"new Decoder().decode()",
		"string",
		'import { TextDecoder as Decoder } from "node:util";',
	],
	["new URL('https://example.test/?q=value').searchParams.has('q')", "boolean", ""],
	[
		"Ctor.parse('https://example.test').hostname",
		"string",
		'import { URL as Ctor } from "url";',
	],
	[
		"Bytes.from('abc').readUInt8()",
		"number",
		'import { Buffer as Bytes } from "node:buffer";',
	],
	[
		"Bytes.alloc(8).readBigUInt64LE()",
		"bigint",
		'import { Buffer as Bytes } from "buffer";',
	],
	[
		"new DatabaseSync(':memory:').prepare('select 1').all()",
		"string",
		'import { DatabaseSync } from "node:sqlite";',
	],
	["AbortSignal.timeout(0).aborted", "boolean", ""],
	["new TextEncoderStream().encoding", "string", ""],
	["(await new Blob(['hi']).stream().getReader().read()).done", "boolean", ""],
	["await new WritableStream().getWriter().close()", "undefined", ""],
	["new ReadableStream().locked", "boolean", ""],
	[
		"new Readable().locked",
		"boolean",
		'import { ReadableStream as Readable } from "node:stream/web";',
	],
	["new CountQueuingStrategy({ highWaterMark: 1 }).size('chunk')", "number", ""],
	["new CloseEvent('close').code", "number", ""],
	["new EventTarget().dispatchEvent(new Event('test'))", "boolean", ""],
	["performance.now()", "number", ""],
	[
		"new BlockList().check('127.0.0.1')",
		"boolean",
		'import { BlockList } from "node:net";',
	],
	["new Server().listening", "boolean", 'import { Server } from "node:net";'],
	[
		"createServer().headersTimeout",
		"number",
		'import { createServer } from "node:http";',
	],
	[
		"createServer().keepAliveTimeout",
		"number",
		'import { createServer } from "node:https";',
	],
	[
		"connect({ port: 443 }).getProtocol()",
		"number",
		'import { connect } from "node:tls";',
	],
	[
		"createSocket('udp4').getSendQueueCount()",
		"number",
		'import { createSocket } from "node:dgram";',
	],
	[
		"new ChildProcess().kill()",
		"boolean",
		'import { ChildProcess } from "node:child_process";',
	],
	[
		"EventEmitter.defaultMaxListeners",
		"number",
		'import { EventEmitter } from "node:events";',
	],
	[
		"createHash('sha256').isPaused()",
		"boolean",
		'import { createHash } from "node:crypto";',
	],
	["new Readable().read(0)", "string", 'import { Readable } from "node:stream";'],
	[
		"Readable.from(['chunk']).isPaused()",
		"boolean",
		'import { Readable } from "node:stream";',
	],
	[
		"Readable.toWeb(new Readable()).locked",
		"boolean",
		'import { Readable } from "stream";',
	],
	["createGzip()._closed", "boolean", 'import { createGzip } from "node:zlib";'],
	["createGzip().reset()", "undefined", 'import { createGzip } from "node:zlib";'],
	[
		"gzipSync('chunk', { info: true }).buffer.readUInt8(0)",
		"number",
		'import { gzipSync } from "node:zlib";',
	],
	["setTimeout(() => {}, 0).hasRef()", "boolean", ""],
	["atob('YWJj')", "string", ""],
	[
		"new StringDecoder('utf8').end()",
		"string",
		'import { StringDecoder } from "node:string_decoder";',
	],
	[
		"createHash('sha256').update('input').digest('hex')",
		"string",
		'import { createHash } from "node:crypto";',
	],
	[
		"createHash('sha256').digest('unrecognized')",
		"string",
		'import { createHash } from "node:crypto";',
	],
	["await crypto.subtle.digest('SHA-256', new Uint8Array())", "string", ""],
	[
		"await subtle.verify('HMAC', options, new Uint8Array(), new Uint8Array())",
		"boolean",
		'import { subtle } from "node:crypto";',
	],
	[
		"MIMEType.parse('text/plain;charset=utf-8').params.has('charset')",
		"boolean",
		'import { MIMEType } from "node:util";',
	],
	[
		"await scheduler.yield()",
		"undefined",
		'import { scheduler } from "node:timers/promises";',
	],
	[
		"(await setInterval(1).return()).done",
		"boolean",
		'import { setInterval } from "node:timers/promises";',
	],
	[
		"new EventEmitter().listenerCount('data')",
		"number",
		'import { EventEmitter } from "node:events";',
	],
	[
		"new AsyncLocalStorage().withScope('value').dispose()",
		"undefined",
		'import { AsyncLocalStorage } from "node:async_hooks";',
	],
	[
		"new AsyncResource('example').asyncId()",
		"number",
		'import { AsyncResource } from "node:async_hooks";',
	],
	[
		"parse('https://example.test').resolve('/path')",
		"string",
		'import { parse } from "node:url";',
	],
	[
		"new MessageChannel().port1.hasRef()",
		"boolean",
		'import { MessageChannel } from "node:worker_threads";',
	],
	[
		"new MessageChannel().port1.postMessage('value')",
		"undefined",
		'import { MessageChannel } from "node:worker_threads";',
	],
	[
		"capabilities().sharedMemory",
		"boolean",
		'import { capabilities } from "maligator:workers";',
	],
	[
		"new MessageChannel().port1.hasRef()",
		"boolean",
		'import { MessageChannel } from "maligator:workers";',
	],
	["statSync(path).isFile()", "boolean", 'import { statSync } from "node:fs";'],
	[
		"(await stat(path, { bigint: true })).isFile()",
		"boolean",
		'import { stat } from "node:fs/promises";',
	],
	[
		"(await (await open(path)).stat()).isFile()",
		"boolean",
		'import { open } from "node:fs/promises";',
	],
	[
		"await (await opendir(path)).read()",
		"number",
		'import { opendir } from "node:fs/promises";',
	],
	[
		"opendirSync(path).read(() => {})",
		"undefined",
		'import { opendirSync } from "node:fs";',
	],
])("uses the installed host object contract for %s", (expression, type, imports) => {
	expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
});

it.each([
	[
		"filesystem.readFileSync(path, 'utf8')",
		"string",
		'import filesystem from "node:fs";',
	],
	["await filesystem.promises.readFile(path)", "string", 'import filesystem from "fs";'],
	["paths.posix.basename(path)", "string", 'import paths from "node:path";'],
])("follows the installed default export for %s", (expression, type, imports) => {
	const operations = inspectHostCall(expression, type, "", imports);
	expect(operations).toContain("call");
	expect(operations).not.toContain("typeofCompare");
});

it("does not apply the native contract when a default export member changes", () => {
	const operations = inspectHostCall(
		"filesystem.readFileSync(path, 'utf8')",
		"number",
		"filesystem.readFileSync = () => options;",
		'import filesystem from "node:fs";',
	);
	expect(operations).toContain("typeofCompare");
});
