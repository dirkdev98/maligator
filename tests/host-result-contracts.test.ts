import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { HOST_MODULES } from "../src/compiler/frontend/host-modules.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import type { BuildModuleGraphOptions } from "../src/compiler/frontend/module-graph.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	DISK_HANDLE_EXPORTS,
	DISK_HANDLE_RESULTS,
	HOST_RESULT_CONTRACTS,
	NODE_FILE_HANDLE_RESULTS,
	WEB_FETCH_CONSTRUCTORS,
	WEB_FETCH_RESULTS,
} from "../src/compiler/shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
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
				operations = coreOperations(coreFunctionNamed(program, "inspect")!);
			},
		});
		return operations!.map(({ opcode }) => opcode);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it.each([
	["readSync(path, 'utf8')", "string"],
	["readSync(path, null)", "string"],
	["readSync(path)", "string"],
	["readSync(path, options)", "number"],
	["readSync(path, { encoding: 'utf8' })", "string"],
	["await readAsync(path, 'utf8')", "string"],
	["await readAsync(path)", "string"],
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

it.each([
	["await file(path).text()", "string"],
	["await file(path).bytes()", "string"],
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
		const members = DISK_HANDLE_RESULTS[kind];
		expect(
			handles.get(kind === "file" ? "DiskFileHandle" : "DiskDirectoryHandle"),
		).toEqual(new Set([...members.methods.keys(), ...members.properties.keys()]));
	}
});

it("accounts for the installed Fetch constructors, methods, and getters", () => {
	const catalog = getPrimordialCatalog();
	const inventory = [
		...WEB_FETCH_CONSTRUCTORS.map((name) => ({
			name,
			constructorPath: `globalThis.${name}`,
			prototype: `globalThis.${name}.prototype`,
		})),
		{
			name: "HeadersIterator",
			prototype: "%MAL_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE%",
		} as const,
		{
			name: "FormDataIterator",
			prototype: "%MAL_INTRINSIC_FORM_DATA_ITERATOR_PROTOTYPE%",
		} as const,
	];
	const missing: Array<string> = [];
	for (const owner of inventory) {
		const lookup = (identity: string) =>
			catalog.nodes.find(([name]) => name === identity)!;
		const group =
			"constructorPath" in owner
				? [lookup(owner.constructorPath), lookup(owner.prototype)]
				: [lookup(owner.prototype)];
		for (const [name, , , , properties] of group) {
			for (const [key, , value, getter] of properties) {
				if (key === "constructor") continue;
				const member =
					typeof key === "string"
						? key
						: `[${catalog.nodes[key[0]]![0].replaceAll("%", "")}]`;
				if (getter >= 0 && !WEB_FETCH_RESULTS.properties[owner.name]?.has(member))
					missing.push(`${name}.${member} getter`);
				if (typeof value !== "number" || (catalog.nodes[value]![2] & 2) === 0) continue;
				const methods =
					name === owner.prototype
						? WEB_FETCH_RESULTS.methods[owner.name]
						: WEB_FETCH_RESULTS.statics[owner.name];
				if (!methods?.has(member)) missing.push(`${name}.${member}`);
			}
		}
	}
	expect(missing).toEqual([]);
});
