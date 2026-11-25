import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	HOST_RESULT_CONTRACTS,
	WEB_FETCH_CONSTRUCTORS,
	WEB_FETCH_RESULTS,
} from "../src/compiler/shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

const namedImports = `
	import { readFileSync as readSync } from "node:fs";
	import { readFile as readAsync } from "node:fs/promises";
	import { basename } from "node:path/posix";
	import { uptime } from "node:os";
`;

function inspectHostCall(
	expression: string,
	type: string,
	setup = "",
	imports = namedImports,
) {
	const directory = mkdtempSync(join(tmpdir(), "mal-host-result-"));
	try {
		const entry = join(directory, "entry.mjs");
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
		const graph = buildModuleGraph(entry);
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

it("accounts for callable named exports in each audited native module", () => {
	const catalog = getPrimordialCatalog();
	const missing = catalog.roots.flatMap(([root, node]) => {
		const colon = root.indexOf(":");
		const contracts = HOST_RESULT_CONTRACTS.get(root.slice(0, colon));
		const name = root.slice(colon + 1);
		return contracts !== undefined &&
			name !== "default" &&
			typeof node === "number" &&
			(catalog.nodes[node]![2] & 2) !== 0 &&
			!contracts.has(name)
			? [root]
			: [];
	});
	expect(missing).toEqual([]);
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
