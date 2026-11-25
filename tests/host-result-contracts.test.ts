import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	HOST_GLOBAL_INSTALLERS,
	HOST_MODULES,
	lookupHostModule,
	SOURCE_HOST_MODULES,
} from "../src/compiler/frontend/host-modules.ts";
import {
	buildModuleGraph,
	ModuleParseCache,
} from "../src/compiler/frontend/module-graph.ts";
import type { BuildModuleGraphOptions } from "../src/compiler/frontend/module-graph.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	ATOMIC_ELEMENT_RESULT_OPERATIONS,
	builtinNormalResultKinds,
	builtinNumericRangeUnavailable,
	builtinResultIntegerRange,
} from "../src/compiler/shared/builtin-registry.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	hostConstructorInvocation,
	hostGetterInvocation,
	hostGlobalInvocation,
	hostMemberInvocation,
	hostModuleInvocation,
} from "../src/compiler/shared/host-invocation-contracts.ts";
import {
	hostConstructorInvocationUnavailable,
	hostGetterInvocationUnavailable,
	hostMemberInvocationUnavailable,
	hostModuleInvocationUnavailable,
	hostStaticInvocationUnavailable,
} from "../src/compiler/shared/host-invocation-dispositions.ts";
import {
	BUFFER_STRING_ENCODINGS,
	CAPTURED_HOST_RESULTS,
	GLOBAL_HOST_FUNCTION_RESULTS,
	GLOBAL_HOST_OBJECT_BRANDS,
	GLOBAL_HOST_NAMESPACE_RESULTS,
	CRYPTO_STREAM_DELEGATES,
	DISK_HANDLE_EXPORTS,
	EMBEDDED_ASSET_RESULTS,
	PLATFORM_OBJECT_RESULTS,
	HOST_RESULT_CONTRACTS,
	NODE_FILE_HANDLE_RESULTS,
	NODE_TEST_EXPORT_TARGETS,
	PLATFORM_SOURCE_EXPORTS,
	TEST_MATCHER_NAMES,
	GLOBAL_HOST_CONSTRUCTORS,
	GLOBAL_HOST_ABSTRACT_CONSTRUCTORS,
	HOST_OBJECT_RESULTS,
} from "../src/compiler/shared/host-result-contracts.ts";
import type {
	HostObjectKind,
	HostResultContract,
} from "../src/compiler/shared/host-result-contracts.ts";
import { compilerIntegerRangeIsValid } from "../src/compiler/shared/integer-range.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import { primordialNode } from "../src/compiler/shared/primordial-catalog.ts";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

const namedImports = `
	import { readFileSync as readSync } from "node:fs";
	import { readFile as readAsync } from "node:fs/promises";
	import { open } from "node:fs/promises";
	import { basename } from "node:path/posix";
	import { uptime } from "node:os";
`;

function hostInputAccesses(source: string) {
	const directory = mkdtempSync(join(tmpdir(), "mal-host-input-"));
	try {
		const entry = join(directory, "entry.mjs");
		writeFileSync(entry, source);
		const image = compileEntrypoint(entry, {
			buildConfig: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
		});
		return new Map(
			image.native.functions.map((fn) => [
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				),
				fn.body.instructions.flatMap((instruction, ip) =>
					instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC"
						? [fn.instructions[ip]?.kind ?? "generic"]
						: [],
				),
			]),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it("uses the original native predicate brand through a negated alias", () => {
	const accesses = hostInputAccesses(`
		import { types } from "node:util";
		import { Buffer } from "node:buffer";
		globalThis.inspect = function inspect(value) {
			const alias = value;
			const accepted = types.isUint8Array(value);
			if (!accepted) return;
			return alias[0];
		};
		globalThis.inspectBuffer = function inspectBuffer(value) {
			if (Buffer.isBuffer(value)) return value[0];
		};
	`);
	expect(accesses.get("inspect")).toContain("exact-typed-array-element");
	expect(accesses.get("inspectBuffer")).toContain("exact-typed-array-element");
});

it("keeps generic element access after a conflicting join or an overridden predicate", () => {
	const joined = hostInputAccesses(`
		import { types } from "node:util";
		globalThis.inspect = function inspect(value, alternate) {
			if (!types.isUint8Array(value) && !alternate) return;
			return value[0];
		};
	`);
	const overridden = hostInputAccesses(`
		import { types } from "node:util";
		types.isUint8Array = () => true;
		globalThis.inspect = function inspect(value) {
			if (types.isUint8Array(value)) return value[0];
		};
	`);
	expect(joined.get("inspect")).not.toContain("exact-typed-array-element");
	expect(overridden.get("inspect")).not.toContain("exact-typed-array-element");
});

it("uses strict path validation only after successful completion", () => {
	const accesses = hostInputAccesses(`
		import { isAbsolute } from "node:path/posix";
		globalThis.inspect = function inspect(value) {
			const length = value.length;
			try {
				isAbsolute(value);
				return length + value.length;
			} catch {
				return value.length;
			}
		};
	`);
	expect(accesses.get("inspect")).toEqual([
		"generic",
		"primitive-string-length",
		"generic",
	]);
});

it("retains a generic length access for an uncertain or coercing call", () => {
	const accesses = hostInputAccesses(`
		import { isIP } from "node:net";
		globalThis.inspect = function inspect(value) {
			isIP(value);
			return value.length;
		};
		globalThis.inspectIndirect = function inspectIndirect(predicate, value) {
			if (predicate(value)) return value.length;
		};
	`);
	expect(accesses.get("inspect")).toContain("generic");
	expect(accesses.get("inspectIndirect")).toContain("generic");
});

it("uses native constructor validation after the constructor completes", () => {
	const observe = 'typeof path === "number"';
	const strict = inspectHostCall(
		"new DataView(path)",
		"",
		"",
		"",
		undefined,
		"inspect",
		observe,
	);
	const coercing = inspectHostCall(
		"new ArrayBuffer(path)",
		"",
		"",
		"",
		undefined,
		"inspect",
		observe,
	);
	expect(strict).not.toContain("typeofCompare");
	expect(coercing).toContain("typeofCompare");
});

it("carries input proofs through exact synchronous wrappers", () => {
	const accesses = hostInputAccesses(`
		import { isAbsolute } from "node:path/win32";
		import { types } from "node:util";
		function validate(value, steps) {
			for (let i = 0; i < steps; i++) globalThis.visited = i;
			return isAbsolute(value);
		}
		function reject(value, steps) {
			for (let i = 0; i < steps; i++) globalThis.visited = i;
			return !types.isUint8Array(value);
		}
		globalThis.inspect = function inspect(value, steps) {
			validate(value, steps);
			return value.length;
		};
		globalThis.inspectBytes = function inspectBytes(value, steps) {
			if (reject(value, steps)) return;
			return value[0];
		};
	`);
	expect(accesses.get("inspect")).toContain("primitive-string-length");
	expect(accesses.get("inspectBytes")).toContain("exact-typed-array-element");
});

it("uses asynchronous validation after fulfillment while preserving the await", () => {
	const imports = 'import { readlink } from "node:fs/promises";';
	const observe = 'typeof path === "number"';
	const before = inspectHostCall(
		"readlink(path)",
		"",
		"",
		imports,
		undefined,
		"inspect",
		observe,
	);
	const after = inspectHostCall(
		"await readlink(path)",
		"",
		"",
		imports,
		undefined,
		"inspect",
		observe,
	);
	expect(before).toContain("typeofCompare");
	expect(after).toContain("await");
	expect(after).not.toContain("typeofCompare");
	const continued = inspectHostCall(
		"await readlink(path).then((name) => name)",
		"",
		"",
		imports,
		undefined,
		"inspect",
		observe,
	);
	const recovered = inspectHostCall(
		"await readlink(path).catch(() => 'missing')",
		"",
		"",
		imports,
		undefined,
		"inspect",
		observe,
	);
	expect(continued).not.toContain("typeofCompare");
	expect(recovered).toContain("typeofCompare");
});

it("accounts for installed named predicates, validators and the path family", () => {
	const prefixes = [
		"mal_host_install_node_util_types:",
		"mal_host_install_node_path:",
		"mal_host_install_node_path_posix:",
		"mal_host_install_node_path_win32:",
	];
	const catalog = getPrimordialCatalog();
	const missing = catalog.roots.flatMap(([root, value]) => {
		if (
			typeof value !== "number" ||
			(!prefixes.some((prefix) => root.startsWith(prefix)) &&
				!/^mal_host_install_\w+:(is[A-Z]|validate[A-Z]|hasSubscribers)/.test(root)) ||
			(catalog.nodes[value]![2] & 2) === 0
		)
			return [];
		const separator = root.indexOf(":");
		const name = root.slice(separator + 1);
		if (name === "default") return [];
		return HOST_RESULT_CONTRACTS.get(root.slice(0, separator))?.get(name)?.inputs ===
			undefined
			? [root]
			: [];
	});
	expect(missing).toEqual([]);
});

it("forwards a private field across a borrowing native predicate", () => {
	const setup = "const state = { value: path };";
	const borrowed = inspectHostCall(
		"isUint8Array(state)",
		"",
		setup,
		'import { isUint8Array } from "node:util/types";',
		undefined,
		"inspect",
		"state.value",
	);
	const opaque = inspectHostCall(
		"options(state)",
		"",
		setup,
		"",
		undefined,
		"inspect",
		"state.value",
	);
	expect(borrowed).toContain("call");
	expect(borrowed).not.toContain("loadPropertyStatic");
	expect(opaque).toContain("loadPropertyStatic");
});

it("forwards a private field across an unused native constructor argument", () => {
	const operations = inspectHostCall(
		"new TextEncoder(state)",
		"",
		"const state = { value: path };",
		"",
		undefined,
		"inspect",
		"state.value",
	);
	expect(operations).toContain("construct");
	expect(operations).not.toContain("loadPropertyStatic");
});

it("publishes a native identity argument when the enclosing function stores the result", () => {
	inspectHostCall(
		"publish(path)",
		"",
		"",
		`import { getRandomValues } from "node:crypto";
		function publish(value) { globalThis.samples = getRandomValues(value); }
		globalThis.publishSamples = publish;`,
		undefined,
		"publish",
		"result",
		(program) => {
			const fn = coreFunctionNamed(program, "publish")!;
			const analyses = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const summary = analyses
				.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
				.summary(fn.id)!;
			expect(summary.parameterEscape).toEqual(["retained"]);
			expect(summary.effects.writes).toContain("array-element");
		},
	);
});

it("records invocation dispositions for installed native module exports", () => {
	const catalog = getPrimordialCatalog();
	const installers = new Set([
		...[...HOST_MODULES.values()].map(({ installer }) => installer),
		...PLATFORM_MODULES.flatMap((module) =>
			module.kind === "native" ? [module.installer] : [],
		),
	]);
	const audited = (installer: string, name: string) => {
		const result = HOST_RESULT_CONTRACTS.get(installer)?.get(name);
		return (
			result?.kind === "callback" ||
			result?.kind === "never" ||
			(result?.kind === "return" && result.value.hostConstructor !== undefined) ||
			hostModuleInvocation(installer, name) !== undefined ||
			hostModuleInvocationUnavailable(installer, name) !== undefined
		);
	};
	const missing = catalog.roots.flatMap(([root, value]) => {
		const separator = root.indexOf(":");
		const installer = root.slice(0, separator);
		return typeof value === "number" &&
			(catalog.nodes[value]![2] & 2) !== 0 &&
			installers.has(installer) &&
			!audited(installer, root.slice(separator + 1))
			? [root]
			: [];
	});
	for (const definition of PLATFORM_MODULES) {
		if (definition.kind !== "native") continue;
		for (const member of definition.exports) {
			if (
				member.contract.value === "callable" &&
				!audited(definition.installer, member.name)
			)
				missing.push(`${definition.id}.${member.name}`);
		}
	}
	expect(missing).toEqual([]);
});

function inspectHostCall(
	expression: string,
	type: string,
	setup = "",
	imports = namedImports,
	virtualModules?: BuildModuleGraphOptions["virtualModules"],
	inspected = "inspect",
	observation = `typeof result === ${JSON.stringify(type)}`,
	check?: (program: CoreProgram) => void,
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
				return ${observation};
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
				check?.(program);
			},
		});
		return operations!.map(({ opcode, attributes }) =>
			opcode === "binary" ? `binary:${attributes.operator as string}` : opcode,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it.each([
	["readUInt8(0)", "result > 255"],
	["readInt8(0)", "result < -128"],
	["readUInt16LE(0)", "result > 65535"],
	["readUint16BE(0)", "result < 0"],
	["readInt16BE(0)", "result > 32767"],
	["readUInt32LE(0)", "result > 4294967295"],
	["readInt32BE(0)", "result < -2147483648"],
	["readUIntLE(0, 3)", "result > 16777215"],
	["readIntBE(0, 5)", "result < -549755813888"],
	["readUIntBE(0, options)", "result > 281474976710655"],
])(
	"folds the integer bound of Buffer.%s while keeping the access",
	(method, comparison) => {
		const operations = inspectHostCall(
			`bytes.${method}`,
			"number",
			"const bytes = Buffer.alloc(6);",
			'import { Buffer } from "node:buffer";',
			undefined,
			undefined,
			comparison,
		);
		expect(operations).toContain("call");
		expect(operations).not.toContain(`binary:${comparison.split(" ")[1]}`);
	},
);

it("keeps the comparison for a floating-point reader", () => {
	const operations = inspectHostCall(
		"bytes.readFloatLE(0)",
		"number",
		"const bytes = Buffer.alloc(4);",
		'import { Buffer } from "node:buffer";',
		undefined,
		undefined,
		"result < 0",
	);
	expect(operations).toContain("binary:<");
});

it("uses the native unsigned bound through an ordinary wrapper", () => {
	const operations = inspectHostCall(
		"checksum(path)",
		"number",
		"function checksum(value) { return crc32(value); }",
		'import { crc32 } from "node:zlib";',
		undefined,
		undefined,
		"result < 0",
	);
	expect(operations).not.toContain("binary:<");
});

it("uses the response status range without removing the getter", () => {
	const operations = inspectHostCall(
		"new Response().status",
		"number",
		"",
		"",
		undefined,
		undefined,
		"result > 2147483647",
	);
	expect(operations).toContain("loadPropertyStatic");
	expect(operations).not.toContain("binary:>");
});

it("joins native ranges returned by a wrapper", () => {
	const operations = inspectHostCall(
		"read(options)",
		"number",
		`function read(flag) {
			const bytes = Buffer.alloc(2);
			return flag ? bytes.readUInt8(0) : bytes.readUint16LE(0);
		}`,
		'import { Buffer } from "node:buffer";',
		undefined,
		undefined,
		"result > 65535",
	);
	expect(operations).not.toContain("binary:>");
});

it("keeps the comparison when the reader identity can be replaced", () => {
	const operations = inspectHostCall(
		"bytes.readUInt8(0)",
		"number",
		`const bytes = Buffer.alloc(1); bytes.readUInt8 = options;`,
		'import { Buffer } from "node:buffer";',
		undefined,
		undefined,
		"result > 255",
	);
	expect(operations).toContain("binary:>");
});

it("uses a native byte count after fulfillment and a Promise continuation", () => {
	const operations = inspectHostCall(
		"await file(path).write('content').then((written) => written)",
		"number",
		"",
		'import { file } from "maligator:fs";',
		undefined,
		undefined,
		"result < 0",
	);
	expect(operations).toContain("await");
	expect(operations).not.toContain("binary:<");
});

it.each([
	["new DataView(new ArrayBuffer(2)).getUint16(path)", "result > 65535", "binary:>"],
	["Math.clz32(path)", "result > 32", "binary:>"],
	["Atomics.load(new Uint32Array(1), path)", "result < 0", "binary:<"],
])("uses the numeric result range of %s", (expression, comparison, opcode) => {
	const operations = inspectHostCall(
		expression,
		"number",
		"",
		"",
		undefined,
		undefined,
		comparison,
	);
	expect(operations).not.toContain(opcode);
});

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

it("uses the entry list supplied to a private performance observer callback", () => {
	const operations = inspectHostCall(
		`new PerformanceObserver(function observed(list) {
			globalThis.output = typeof list.getEntries() === 'number';
		})`,
		"object",
		"",
		"",
		undefined,
		"observed",
	);
	expect(operations).toContain("call");
	expect(operations).not.toContain("typeofCompare");
});

it("uses the context supplied to an ordinary node:test body", () => {
	const operations = inspectHostCall(
		`test('fixture', function checked(context) {
			globalThis.output = typeof context.plan(0) === 'undefined';
		})`,
		"object",
		"",
		'import { test } from "node:test";',
		undefined,
		"checked",
	);
	expect(operations).toContain("call");
	expect(operations).not.toContain("typeofCompare");
});

it.each([
	"expect(1).not.toBe(2)",
	"await expect(Promise.resolve(1)).resolves.toBe(1)",
	"test.each([[1]])('fixture', () => {})",
])("uses the successful result of the packaged test API %s", (expression) => {
	const runtime = readFileSync(
		new URL("../src/testing/runtime.mjs", import.meta.url),
		"utf8",
	);
	const modules = new Map([["maligator:test", { source: runtime, platform: true }]]);
	const operations = inspectHostCall(
		expression,
		"undefined",
		"",
		'import { expect, test } from "maligator:test";',
		modules,
	);
	expect(operations).not.toContain("typeofCompare");
});

it("accounts for matchers installed by the packaged test runtime", () => {
	const source = readFileSync(
		new URL("../src/testing/runtime.mjs", import.meta.url),
		"utf8",
	);
	const { ast } = parseModule(source);
	const matchers = ast.body
		.flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
		.find(({ id }) => id.type === "Identifier" && id.name === "MATCHERS")?.init;
	expect(matchers?.type).toBe("ArrayExpression");
	if (matchers?.type !== "ArrayExpression") return;
	expect(
		new Set(
			matchers.elements.map((node) =>
				node?.type === "Literal" ? node.value : undefined,
			),
		),
	).toEqual(new Set(TEST_MATCHER_NAMES));
});

it.each([
	[
		"statSync(path, { bigint: true }).size",
		"bigint",
		'import { statSync } from "node:fs";',
	],
	["statSync(path).size", "number", 'import { statSync } from "node:fs";'],
	[
		"(await stat(path, { bigint: true })).size",
		"bigint",
		'import { stat } from "node:fs/promises";',
	],
	[
		"(await (await open(path)).read()).bytesRead",
		"number",
		'import { open } from "node:fs/promises";',
	],
	[
		"readdirSync(path, {withFileTypes: true})[0].isFile()",
		"boolean",
		'import { readdirSync } from "node:fs";',
	],
	[
		"(await readdir(path, {withFileTypes: true}))[0].isFile()",
		"boolean",
		'import { readdir } from "node:fs/promises";',
	],
	[
		"await (await mkdtempDisposable(path)).remove()",
		"undefined",
		'import { mkdtempDisposable } from "node:fs/promises";',
	],
	[
		"mkdtempDisposableSync(path).path",
		"string",
		'import { mkdtempDisposableSync } from "node:fs";',
	],
	[
		"mkdtempDisposableSync(path, 'buffer').path.readUInt8(0)",
		"number",
		'import { mkdtempDisposableSync } from "node:fs";',
	],
	[
		"(await mkdtempDisposable(path, { encoding: 'buffer' })).path.readUInt8(0)",
		"number",
		'import { mkdtempDisposable } from "node:fs/promises";',
	],
	["(await file(path).stat()).isFile", "boolean", 'import { file } from "maligator:fs";'],
	["file(path).stream().locked", "boolean", 'import { file } from "maligator:fs";'],
	["navigator.hardwareConcurrency", "number", ""],
])("uses the record or element contract of %s", (expression, type, imports) => {
	expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
});

it.each([
	[
		"mkdtempDisposableSync(path, options).path",
		'import { mkdtempDisposableSync } from "node:fs";',
	],
	[
		"(await mkdtempDisposable(path, options)).path",
		'import { mkdtempDisposable } from "node:fs/promises";',
	],
])(
	"keeps the path type observation when the encoding is unknown in %s",
	(expression, imports) => {
		expect(inspectHostCall(expression, "string", "", imports)).toContain("typeofCompare");
	},
);

it("retains member observations when TLS can dispatch a native connection listener", () => {
	const operations = inspectHostCall(
		"new Response('').ok",
		"boolean",
		"createServer().emit('connection');",
		'import { createServer } from "node:tls";',
	);
	expect(operations).toContain("typeofCompare");
});

it.each([
	["name", "number"],
	["parentPath", "boolean"],
])("keeps an observation of the caller-supplied Dirent %s", (field, type) => {
	const operations = inspectHostCall(
		`new Dirent(42, 1, false).${field}`,
		type,
		"",
		'import { Dirent } from "node:fs";',
	);
	expect(operations).toContain("typeofCompare");
});

it.each([
	[
		"readFileSync(path).readUInt8(0)",
		"number",
		'import { readFileSync } from "node:fs";',
	],
	[
		"createReadStream(path).path",
		"string",
		'import { createReadStream } from "node:fs";',
	],
	[
		"createWriteStream(path).bytesWritten",
		"number",
		'import { createWriteStream } from "node:fs";',
	],
	["os.uptime()", "number", 'import os from "os";'],
	["querystring.escape(path)", "string", 'import querystring from "node:querystring";'],
	["types.isPromise(path)", "boolean", 'import types from "node:util/types";'],
	["parentPort", "number", 'import { parentPort } from "maligator:workers";'],
])(
	"uses the contract through the installer selected for %s",
	(expression, type, imports) => {
		expect(inspectHostCall(expression, type, "", imports)).not.toContain("typeofCompare");
	},
);

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
			!numericContractAudited(contracts?.get(name))
			? [root]
			: [];
	});
	for (const definition of PLATFORM_MODULES) {
		if (definition.kind !== "native") continue;
		for (const member of definition.exports) {
			if (
				member.contract.value === "callable" &&
				!numericContractAudited(
					HOST_RESULT_CONTRACTS.get(definition.installer)?.get(member.name),
				)
			)
				missing.push(`${definition.id}.${member.name}`);
		}
	}
	expect(missing).toEqual([]);
});

function numericContractAudited(contract: HostResultContract | undefined): boolean {
	if (contract === undefined) return false;
	if (!("value" in contract)) return true;
	const { mask, integerRange, numericRangeUnavailable, selector } = contract.value;
	if ((mask & COMPILER_VALUE_KIND_NUMBER) === 0) return integerRange === undefined;
	if (integerRange !== undefined) return compilerIntegerRangeIsValid(integerRange);
	return (
		numericRangeUnavailable !== undefined ||
		("reason" in contract && contract.reason !== undefined) ||
		selector?.kind === "random-int" ||
		selector?.kind === "resolve-value"
	);
}

it("accounts for numeric completions of installed ECMAScript operations", () => {
	const missing = getPrimordialCatalog().nodes.flatMap(([identity, , flags]) => {
		if (
			(flags & 2) === 0 ||
			((builtinNormalResultKinds(identity) ?? 0) & COMPILER_VALUE_KIND_NUMBER) === 0
		)
			return [];
		const range = builtinResultIntegerRange(identity);
		return compilerIntegerRangeIsValid(range) ||
			ATOMIC_ELEMENT_RESULT_OPERATIONS.has(identity) ||
			builtinNumericRangeUnavailable(identity) !== undefined
			? []
			: [identity];
	});
	expect(missing).toEqual([]);
});

it("accounts for runtime exports of all packaged source modules", () => {
	const modules = new Map([
		...SOURCE_HOST_MODULES,
		...PLATFORM_MODULES.flatMap((module) =>
			module.kind === "source" ? [[module.id, module.sourceFile] as const] : [],
		),
	]);
	const missing: Array<string> = [];
	for (const [id, file] of modules) {
		const url = new URL(`../src/${file}`, import.meta.url);
		const source = readFileSync(url, "utf8");
		const { ast } = parseModule(
			file.endsWith(".ts") ? stripCompactTypes(source, url.pathname) : source,
		);
		const nativeImports = new Set<string>();
		for (const node of ast.body) {
			if (node.type !== "ImportDeclaration") continue;
			const installer = lookupHostModule(node.source.value)?.installer;
			if (installer === undefined) continue;
			for (const specifier of node.specifiers) {
				if (
					specifier.type === "ImportSpecifier" &&
					specifier.imported.type === "Identifier" &&
					HOST_RESULT_CONTRACTS.get(installer)?.has(specifier.imported.name)
				)
					nativeImports.add(specifier.local.name);
			}
		}
		const contracts = PLATFORM_SOURCE_EXPORTS.get(id);
		const check = (name: string, native = false) => {
			const target =
				id === "node:test" ? (NODE_TEST_EXPORT_TARGETS.get(name) ?? name) : name;
			if (!native && !numericContractAudited(contracts?.get(target)))
				missing.push(`${id}.${name}`);
		};
		for (const node of ast.body) {
			if (node.type === "ExportAllDeclaration")
				missing.push(`${id} export from ${node.source.value}`);
			if (node.type === "ExportDefaultDeclaration") check("default");
			if (node.type !== "ExportNamedDeclaration") continue;
			const declaration = node.declaration;
			if (
				declaration?.type === "FunctionDeclaration" ||
				declaration?.type === "ClassDeclaration"
			)
				check(declaration.id!.name);
			if (declaration?.type === "VariableDeclaration") {
				for (const binding of declaration.declarations)
					check(binding.id.type === "Identifier" ? binding.id.name : binding.id.type);
			}
			for (const specifier of node.specifiers) {
				const name =
					specifier.exported.type === "Identifier"
						? specifier.exported.name
						: String(specifier.exported.value);
				const native =
					(node.source === null || node.source === undefined) &&
					specifier.local.type === "Identifier" &&
					nativeImports.has(specifier.local.name);
				check(name, native);
			}
		}
	}
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

it("accounts for members installed on disposable temporary directories", () => {
	const source = readFileSync(
		new URL("../runtime/src/runtime/node_fs.c", import.meta.url),
		"utf8",
	);
	const allocation = source.match(
		/static MalValue node_fs_mkdtemp_disposable\([\s\S]*?\n\}/,
	)?.[0];
	expect(allocation).toBeDefined();
	const fields = [
		...allocation!.matchAll(
			/mal_intrinsic_define_(?:data|getter)\(vm, object, "([^"]+)"/g,
		),
	].map((match) => match[1]);
	const symbols = allocation!.match(/async \? "(\[Symbol\.[^"]+)" : "(\[Symbol\.[^"]+)"/);
	expect(symbols).toBeDefined();
	for (const [kind, index] of [
		["TemporaryDirectory", 1],
		["TemporaryDirectoryBuffer", 1],
		["TemporaryDirectoryText", 1],
		["TemporaryDirectorySync", 2],
		["TemporaryDirectorySyncBuffer", 2],
		["TemporaryDirectorySyncText", 2],
	] as const)
		expect(
			new Set([
				...HOST_OBJECT_RESULTS.methods[kind].keys(),
				...HOST_OBJECT_RESULTS.properties[kind]!.keys(),
			]),
		).toEqual(new Set([...fields, symbols![index]]));
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
				"PerformanceObserverEntryList",
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
	const missingInvocations: Array<string> = [];
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
				!GLOBAL_HOST_ABSTRACT_CONSTRUCTORS.has(name)
			) {
				missing.push(identity);
			}
			if (
				(name === "fetch" || GLOBAL_HOST_FUNCTION_RESULTS.has(name)) &&
				hostGlobalInvocation(name) === undefined
			)
				missingInvocations.push(`${identity} call`);
		}
	}
	for (const [owner, kind] of inventory) {
		const constructor = primordialNode(owner);
		expect(constructor, owner).toBeDefined();
		if (
			owner.startsWith("globalThis.") &&
			hostConstructorInvocation(kind) === undefined &&
			hostConstructorInvocationUnavailable(kind) === undefined
		)
			missingInvocations.push(`${owner} constructor`);
		const prototype = constructor![4].find(([name]) => name === "prototype")?.[2];
		check(
			constructor!,
			HOST_OBJECT_RESULTS.statics[kind],
			HOST_OBJECT_RESULTS.staticProperties[kind],
			kind,
			true,
		);
		if (typeof prototype === "number")
			check(
				nodes[prototype]!,
				HOST_OBJECT_RESULTS.methods[kind],
				HOST_OBJECT_RESULTS.properties[kind],
				kind,
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
			kind,
		);
	const traversed = new Set<number>();
	for (const [name, brand] of GLOBAL_HOST_OBJECT_BRANDS) {
		const node = primordialNode(`globalThis.${name}`);
		if (node !== undefined) visit(nodes.indexOf(node), brand);
	}
	for (const [root, index] of roots) {
		if (typeof index !== "number" || !root.startsWith("mal_host_install_")) continue;
		const contract = fromRoot(root);
		const brand =
			contract?.kind === "return" && contract.value.installedObject
				? contract.value.hostObject
				: undefined;
		visit(index, brand);
	}
	for (const [identity, contract] of CAPTURED_HOST_RESULTS) {
		const callable = primordialNode(identity);
		if (
			callable === undefined ||
			(callable[2] & 2) === 0 ||
			!numericContractAudited(contract)
		)
			missing.push(identity);
	}
	expect(missing.sort()).toEqual([]);
	expect(missingInvocations.sort()).toEqual([]);

	function visit(index: number, brand: HostObjectKind | undefined) {
		if (traversed.has(index)) return;
		traversed.add(index);
		const node = nodes[index]!;
		for (const kind of ["file", "directory"] as const) {
			if (
				node[0] ===
				`%mal_host_install_maligator_assets:Embedded${kind === "file" ? "File" : "Directory"}%`
			) {
				const { methods, properties } = EMBEDDED_ASSET_RESULTS[kind];
				check(node, methods, properties);
				return;
			}
		}
		const constructor = inventory.get(node[0]);
		const properties =
			constructor !== undefined
				? HOST_OBJECT_RESULTS.staticProperties[constructor]
				: brand === undefined
					? undefined
					: HOST_OBJECT_RESULTS.properties[brand];
		const methods =
			constructor !== undefined
				? HOST_OBJECT_RESULTS.statics[constructor]
				: brand === undefined
					? undefined
					: new Map([
							...HOST_OBJECT_RESULTS.methods[brand],
							...(GLOBAL_HOST_NAMESPACE_RESULTS.get(
								node[0].slice("globalThis.".length),
							) ?? []),
						]);
		check(node, methods, properties, constructor ?? brand, constructor !== undefined);
		for (const [key, , value] of node[4]) {
			if (key === "constructor" || key === "prototype" || typeof value !== "number")
				continue;
			const field = typeof key === "string" ? properties?.get(key) : undefined;
			visit(value, field?.kind === "return" ? field.value.hostObject : undefined);
		}
	}

	function check(
		node: (typeof nodes)[number],
		methods: ReadonlyMap<string, HostResultContract> | undefined,
		properties: ReadonlyMap<string, HostResultContract> | undefined,
		brand?: HostObjectKind,
		isStatic = false,
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
			if (
				getter >= 0 &&
				!numericContractAudited(properties?.get(member) ?? installedContract(getter))
			)
				missing.push(`${owner}.${member} getter`);
			if (
				getter >= 0 &&
				brand !== undefined &&
				hostGetterInvocation(brand, member) === undefined &&
				hostGetterInvocationUnavailable(brand, member) === undefined
			)
				missingInvocations.push(`${brand}.${member} getter`);
			if (typeof value !== "number" || (nodes[value]![2] & 2) === 0) continue;
			const contract = methods?.get(member) ?? installedContract(value);
			if (!numericContractAudited(contract)) missing.push(`${owner}.${member}`);
			if (
				brand !== undefined &&
				methods?.has(member) &&
				contract?.kind !== "callback" &&
				contract?.kind !== "never" &&
				hostMemberInvocation(brand, member, isStatic) === undefined &&
				(isStatic ? hostStaticInvocationUnavailable : hostMemberInvocationUnavailable)(
					brand,
					member,
				) === undefined
			)
				missingInvocations.push(`${brand}.${member} ${isStatic ? "static" : "method"}`);
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
