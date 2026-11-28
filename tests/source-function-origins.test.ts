import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import { expect, test } from "vitest";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { forEachEstreeChild } from "../src/compiler/frontend/estree-traversal.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { collectSourceFunctionOrigins } from "../src/compiler/frontend/source-function-origins.ts";
import {
	compileConstructedCoreToProgramImage,
	compileSemanticProgramToProgramImage,
} from "../src/compiler/pipeline/compile-core.ts";
import type { CompileCoreOptions } from "../src/compiler/pipeline/compile-core.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { PreparedProfile, prepareProfile } from "../src/profile-artifact.ts";
import type { ProfileMetadata } from "../src/profile-artifact.ts";
import { SourceProfileIdentities } from "../src/source-profile-identity.ts";
import type { ProfileFunctionIdentity } from "../src/source-profile-identity.ts";

function compile(
	source: string,
	file = "/project/app.js",
	options: CompileCoreOptions = {},
) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		file,
		parseScript(source, { strict: false }),
	);
	const image = compileSemanticProgramToProgramImage(semantic, {
		profile: true,
		optimization: "development",
		...options,
	});
	return { semantic, image };
}

function publish(image: ProgramImage): ProfileMetadata {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-function-origins-"));
	try {
		const binary = path.join(directory, "program");
		writeFileSync(binary, "identity fixture");
		const prepared = prepareProfile(binary, image);
		expect(PreparedProfile.fromFile(`${binary}.profile.jsonl`).readMetadata()).toEqual(
			prepared.readMetadata(),
		);
		return prepared.readMetadata();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function known(profile: ProfileMetadata, name: string) {
	const identity = profile.functions.find((fn) => fn.name === name)?.identity;
	expect(identity?.status).toBe("known");
	if (identity?.status !== "known")
		throw new Error(`Missing known source identity for ${name}`);
	return identity;
}

const reader = "let x = 1; function read() { return x; } globalThis.saved = read;";

test("original call keys distinguish sibling calls and survive unrelated insertion", () => {
	const source = "function run(fn) { return fn(1) + fn(2); } globalThis.saved = run;";
	const before = publish(compile(source).image);
	const after = publish(compile(`function unrelated() { return 9; }\n${source}`).image);
	const keys = (profile: ProfileMetadata) =>
		profile.calls.map((call) => {
			expect(call.identity.status).toBe("known");
			expect(call.lowered).toBe(true);
			return call.identity.status === "known" ? call.identity.key : "";
		});
	expect(keys(before)).toHaveLength(2);
	expect(new Set(keys(before)).size).toBe(2);
	expect(keys(after)).toEqual(keys(before));
	expect(keys(publish(compile(source.replace("fn(2)", "fn(3)")).image))).not.toEqual(
		keys(before),
	);
});

test("source call kinds exclude implicit iterator and constructor helper calls", () => {
	const profile = publish(
		compile(
			"function run(fn, args) { fn?.(...args); new fn(...args); fn`tag`; } globalThis.saved = run;",
		).image,
	);
	expect(
		profile.calls.map((call) => [call.kind, call.lowered, call.identity.status]),
	).toEqual([
		["call", true, "known"],
		["construct", true, "known"],
		["tagged-template", true, "known"],
	]);
});

test("special and unsupported source calls retain explicit lowering coverage", () => {
	const profile = publish(
		compile("function run(text) { return eval(text); } globalThis.saved = run; run('1');")
			.image,
	);
	expect(profile.calls).toHaveLength(2);
	// The eval call site lowers an ordinary call for when `eval` is not %eval%.
	expect(profile.calls[0]).toMatchObject({
		lowered: true,
		identity: { status: "unknown", reason: "dynamic-scope" },
	});
	expect(profile.calls[1]).toMatchObject({
		lowered: true,
		identity: { status: "unknown", reason: "no-source-origin" },
	});
});

test("origin-only Core metadata edits survive runtime lowering and publication", () => {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		reader,
		"/project/app.js",
		parseScript(reader, { strict: false }),
	);
	const constructed = lowerSemanticProgramToCore(semantic, { sourceOrigins: {} });
	const core = constructed.program;
	let updated = 0;
	for (const id of core.functionIds()) {
		if (core.function(id).metadata.sourceOrigin?.status !== "captured") continue;
		const editor = CoreEditor.open(core, id);
		editor.configureFunction({
			metadata: { sourceOrigin: { status: "unknown", reason: "test-replacement" } },
		});
		editor.commit();
		updated++;
	}
	expect(updated).toBe(1);
	const image = compileConstructedCoreToProgramImage(constructed, {
		profile: true,
		optimization: "development",
	});
	expect(publish(image).functions.find((fn) => fn.name === "read")?.identity).toEqual({
		status: "unknown",
		reason: "test-replacement",
	});
});

test("published origins survive an unrelated earlier function and runtime renumbering", () => {
	const before = publish(compile(reader).image);
	const after = publish(
		compile(`function noise() { return 9; } globalThis.noise = noise;\n${reader}`).image,
	);
	expect(before.functions.findIndex((fn) => fn.name === "read")).not.toBe(
		after.functions.findIndex((fn) => fn.name === "read"),
	);
	expect(known(after, "read")).toEqual(known(before, "read"));
	expect(before.functions[0]?.identity).toEqual({
		status: "unknown",
		reason: "no-source-origin",
	});
});

test("body edits preserve the declaration origin and change the exact revision", () => {
	const before = known(publish(compile(reader).image), "read");
	const after = known(
		publish(compile(reader.replace("return x;", "return x + 1;")).image),
		"read",
	);
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
});

test("named class methods have stable identities and distinguish method roles", () => {
	const source = `class Core {
		method() { return 1; }
		static method() { return 2; }
		get value() { return 3; }
		set value(next) { globalThis.next = next; }
		#private() { return 4; }
		read() { return this.#private(); }
	}
	globalThis.Core = Core;`;
	const before = publish(compile(source).image);
	const after = publish(compile(`function noise() { return 0; }\n${source}`).image);
	const methodIdentities = (profile: ProfileMetadata) =>
		profile.functions
			.filter((fn) =>
				["method", "get value", "set value", "#private", "read"].includes(fn.name),
			)
			.map((fn) => fn.identity);
	const identities = methodIdentities(before);
	expect(identities).toHaveLength(6);
	expect(identities.every((identity) => identity.status === "known")).toBe(true);
	expect(
		new Set(
			identities.map((identity) => (identity.status === "known" ? identity.origin : "")),
		).size,
	).toBe(6);
	expect(methodIdentities(after)).toEqual(identities);
});

test("class edits change method revisions while preserving declaration origins", () => {
	const source =
		"class Core { first() { return 1; } second() { return 2; } } globalThis.Core = Core;";
	const before = known(publish(compile(source).image), "first");
	const after = known(
		publish(compile(source.replace("return 2;", "return 3;")).image),
		"first",
	);
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
});

test("class method call keys survive unrelated insertion", () => {
	const source =
		"class Core { run(fn) { return fn(1) + fn(2); } } globalThis.Core = Core;";
	const calls = (profile: ProfileMetadata) =>
		profile.calls.map((call) => {
			expect(call.identity.status).toBe("known");
			return call.identity.status === "known" ? call.identity.key : "";
		});
	const before = calls(publish(compile(source).image));
	const after = calls(
		publish(compile(`function noise() { return 0; }\n${source}`).image),
	);
	expect(before).toHaveLength(2);
	expect(new Set(before).size).toBe(2);
	expect(after).toEqual(before);
});

test("class self-reference bindings survive earlier declarations", () => {
	const source = "class Core { same() { return Core; } } globalThis.Core = Core;";
	const before = known(publish(compile(source).image), "same");
	const after = known(
		publish(compile(`function noise() { return 0; }\n${source}`).image),
		"same",
	);
	expect(after).toEqual(before);
});

test("moving a captured binding changes the revision without changing the reader's text", () => {
	const outer =
		"function outer() { return function read() { return x; }; } globalThis.saved = outer;";
	const before = known(publish(compile(`let x = 1; ${outer}`).image), "read");
	const after = known(
		publish(
			compile(outer.replace("function outer() {", "function outer() { let x = 1;")).image,
		),
		"read",
	);
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
	const unrelated = known(
		publish(compile(`let unused = 0; let x = 1; ${outer}`).image),
		"read",
	);
	expect(unrelated).toEqual(before);
});

test("lexical this and new.target follow their enclosing invocation owner", () => {
	for (const expression of ["this", "new.target"]) {
		const beforeSource = `function host() { const outer = function () { const inner = () => ${
			expression
		}; return inner; }; return outer; } globalThis.saved = host;`;
		const afterSource = beforeSource.replace(
			"const outer = function ()",
			"const outer = () =>",
		);
		const before = known(publish(compile(beforeSource).image), "inner");
		const after = known(publish(compile(afterSource).image), "inner");
		expect(after.origin).toBe(before.origin);
		expect(after.revision).not.toBe(before.revision);
	}
});

test("inherited strictness changes the revision", () => {
	const before = known(publish(compile(reader).image), "read");
	const after = known(publish(compile(`"use strict";\n${reader}`).image), "read");
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
});

test.each(["\n", "\r\n", "\u2028", "\u2029"])(
	"source spans use UTF-16 columns and %j line breaks",
	(newline) => {
		const before = known(publish(compile(reader).image), "read");
		const after = known(publish(compile(`'😀';${newline}${reader}`).image), "read");
		expect(after).toEqual(before);
	},
);

test("explicit module keys transfer across checkouts, while physical identities do not", () => {
	const at = (file: string, portable: boolean) =>
		known(
			publish(
				compile(
					reader,
					file,
					portable ? { profileModuleKeys: new Map([[file, "app/main"]]) } : {},
				).image,
			),
			"read",
		);
	expect(at("/first/app.js", true)).toEqual(at("/second/app.js", true));
	expect(at("/first/app.js", true).portability).toBe("portable");
	expect(at("/first/app.js", false).origin).not.toBe(at("/second/app.js", false).origin);
	expect(at("/first/app.js", false).portability).toBe("checkout");
});

test("publication uses the captured semantic snapshot rather than mutable frontend records or disk", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-origin-source-"));
	try {
		const file = path.join(directory, "app.js");
		writeFileSync(file, reader);
		const { semantic, image } = compile(reader, file);
		const before = known(publish(image), "read");
		semantic.files[0]!.contents = reader.replace("return x;", "return 99;");
		for (const scope of semantic.files[0]!.scopes)
			for (const binding of scope.bindings) binding.name = "changed";
		writeFileSync(file, "throw new Error('changed after compilation');");
		expect(known(publish(image), "read")).toEqual(before);
		expect(
			known(publish(compile(semantic.files[0]!.contents, file).image), "read").revision,
		).not.toBe(before.revision);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Every source function's identity, keyed by its source text, and the module body's. */
function sourceIdentities(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/app.js",
		parseScript(source, { strict: false }),
	);
	const file = semantic.files[0]!;
	const origins = collectSourceFunctionOrigins(semantic, {});
	const identities = new SourceProfileIdentities();
	const functions = new Map<string, ProfileFunctionIdentity>();
	const visit = (node: ESTree.Node) => {
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			const origin = origins.get(file, node);
			const text =
				origin?.status === "captured"
					? source.slice(origin.start, origin.end)
					: `${node.loc?.start.line}:${node.loc?.start.column}`;
			expect(functions.has(text), text).toBe(false);
			functions.set(text, identities.functionIdentity(origin));
		}
		forEachEstreeChild(node, visit);
	};
	visit(file.ast);
	return {
		functions,
		module: identities.functionIdentity(origins.get(file, file.ast)),
	};
}

function knownIdentity(identity: ProfileFunctionIdentity | undefined) {
	expect(identity?.status).toBe("known");
	if (identity?.status !== "known") throw new Error("Missing known source identity");
	return identity;
}

const positioned = `const app = { get(path, handler) { return handler; }, routes: [] };
app.get("/a", (req) => req.a);
app.get("/b", function (req) { return req.b; });
new Promise((resolve) => resolve(1));
exports.handle = function () { return 1; };
app.routes[0] = () => 2;
const routes = { list() { return 3; }, show: () => 4, nested: { deep: () => 5 }, get size() { return 6; } };
const table = [() => 7, () => 8];
function factory() { return function (next) { return next(9); }; }
const twice = () => () => 10;
class Base { ["computed"]() { return 11; } repeated() { return 12; } repeated() { return 13; } field = () => 14; }
const Mixed = class { method() { return 15; } };
(function () { return 16; })();
globalThis.saved = [routes, table, factory, twice, Base, Mixed];
`;

test("functions in every syntactic position get distinct known identities", () => {
	const { functions } = sourceIdentities(positioned);
	const origins = [...functions.values()].map(
		(identity) => knownIdentity(identity).origin,
	);
	expect(new Set(origins).size).toBe(functions.size);
});

test("positioned identities survive unrelated earlier functions and callbacks", () => {
	const before = sourceIdentities(positioned).functions;
	const after = sourceIdentities(
		`function noise() { return 0; }\nsetTimeout(() => 0);\n${positioned}`,
	).functions;
	after.delete("function noise() { return 0; }");
	after.delete("() => 0");
	expect(after).toEqual(before);
});

test("repeated roles are told apart by source order and keep the first's identity", () => {
	const first = "function same() { return 1; }";
	const second = "function same() { return 2; }";
	const alone = sourceIdentities(`${first} globalThis.saved = same;`).functions;
	const repeated = sourceIdentities(
		`${first} ${second} globalThis.saved = same;`,
	).functions;
	expect(knownIdentity(repeated.get(second)).origin).not.toBe(
		knownIdentity(repeated.get(first)).origin,
	);
	expect(repeated.get(first)).toEqual(alone.get(first));
});

test("module top-level code has an identity whose revision covers the whole module", () => {
	const before = knownIdentity(sourceIdentities(positioned).module);
	const after = knownIdentity(
		sourceIdentities(positioned.replace("return 16;", "return 17;")).module,
	);
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
	const functionOrigins = [...sourceIdentities(positioned).functions.values()].map(
		(identity) => knownIdentity(identity).origin,
	);
	expect(functionOrigins).not.toContain(before.origin);
});

test("shared source instances retain their origin without claiming a unique runtime match", () => {
	const { image } = compile(
		"function first() { return 1; } function second() { return 2; } globalThis.saved = [first, second];",
	);
	const names = image.runtime.functions.map((fn) =>
		String.fromCodePoint(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
	);
	const first = names.indexOf("first");
	const second = names.indexOf("second");
	const origins = [...image.diagnostics.profileFunctions!];
	origins[second] = origins[first];
	image.diagnostics.profileFunctions = origins;
	const profile = publish(image);
	expect(profile.functions[first]!.identity.status).toBe("shared");
	expect(profile.functions[second]!.identity).toEqual(profile.functions[first]!.identity);
});

test("ordinary compilation never consults source-origin inputs or retains origin metadata", () => {
	const options: CompileCoreOptions = {
		profile: false,
		get profileModuleKeys(): ReadonlyMap<string, string> {
			throw new Error("unused source origin input");
		},
		afterCoreOptimization(core) {
			for (const id of core.functionIds())
				expect(core.function(id).metadata.sourceOrigin).toBeUndefined();
		},
	};
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		reader,
		"/project/app.js",
		parseScript(reader, { strict: false }),
	);
	const image = compileSemanticProgramToProgramImage(semantic, options);
	expect(image.diagnostics.profileFunctions).toBeUndefined();
});

function moduleProfile(
	directory: string,
	source: string,
	options: CompileCoreOptions = {},
) {
	const entry = path.join(directory, "entry.mjs");
	writeFileSync(entry, source);
	return publish(
		compileSemanticProgramToProgramImage(loadEntrypointAndRunSemanticAnalysis(entry), {
			profile: true,
			optimization: "development",
			...options,
		}),
	);
}

test("directly exported named class methods retain identities across module insertion", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-origin-class-"));
	try {
		const source = "export class Core { read() { return 1; } } globalThis.saved = Core;";
		const before = known(moduleProfile(directory, source), "read");
		const after = known(
			moduleProfile(directory, `export const noise = 0;\n${source}`),
			"read",
		);
		expect(after).toEqual(before);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("resolved ESM export ownership changes revisions but dependency implementation alone does not", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-origin-import-"));
	try {
		writeFileSync(path.join(directory, "a.mjs"), "export const x = 1;");
		writeFileSync(path.join(directory, "b.mjs"), "export const x = 2;");
		const source =
			'import { x } from "./a.mjs"; function read() { return x; } globalThis.saved = read;';
		const before = known(moduleProfile(directory, source), "read");
		const after = known(
			moduleProfile(directory, source.replace("a.mjs", "b.mjs")),
			"read",
		);
		expect(after.origin).toBe(before.origin);
		expect(after.revision).not.toBe(before.revision);
		writeFileSync(path.join(directory, "a.mjs"), "export const x = 99;");
		expect(known(moduleProfile(directory, source), "read")).toEqual(before);
		const partial = known(
			moduleProfile(directory, source, {
				profileModuleKeys: new Map([[path.join(directory, "entry.mjs"), "app/main"]]),
			}),
			"read",
		);
		expect(partial.portability).toBe("checkout");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test.each(["namespace", "commonjs"])(
	"unresolved %s binding contracts remain unknown when imports are retargeted",
	(kind) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-origin-import-"));
		try {
			const extension = kind === "namespace" ? "mjs" : "cjs";
			for (const name of ["a", "b"])
				writeFileSync(
					path.join(directory, `${name}.${extension}`),
					kind === "namespace" ? "export const x = 1;" : "module.exports = { x: 1 };",
				);
			const clause = kind === "namespace" ? "* as ns" : "ns";
			for (const name of ["a", "b"]) {
				const profile = moduleProfile(
					directory,
					`import ${clause} from "./${name}.${
						extension
					}"; function read() { return ns.x; } globalThis.saved = read;`,
				);
				expect(profile.functions.find((fn) => fn.name === "read")?.identity).toEqual({
					status: "unknown",
					reason: "unmapped-binding-owner",
				});
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("explicit module identities cannot silently merge two resolved instances", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-origin-duplicates-"));
	try {
		writeFileSync(path.join(directory, "dep.mjs"), "export const x = 1;");
		expect(() =>
			moduleProfile(directory, 'import { x } from "./dep.mjs"; globalThis.saved = x;', {
				profileModuleKeys: new Map([
					[path.join(directory, "entry.mjs"), "same"],
					[path.join(directory, "dep.mjs"), "same"],
				]),
			}),
		).toThrow("unique nonempty resolved-module keys");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("deeply nested declarations have bounded identity size", () => {
	const depth = 24;
	let source = "function leaf() { return 1; } return leaf;";
	for (let index = depth - 1; index >= 0; index--)
		source = `function nested${index}() { ${source} } ${
			index === 0 ? "globalThis.saved = nested0;" : `return nested${index};`
		}`;
	const { image } = compile(source);
	const origins = image.diagnostics.profileFunctions!.filter(
		(origin) => origin?.status === "captured",
	);
	expect(origins.length).toBe(depth + 1);
	expect(Math.max(...origins.map((origin) => origin.declaration.length))).toBeLessThan(
		source.length * 2,
	);
	expect(known(publish(image), "leaf").revision).toHaveLength(64);
});

test("revision hashing preserves distinct lone-surrogate source code units", () => {
	const source = (value: string) =>
		`function read() { return "${value}"; } globalThis.saved = read;`;
	const before = known(publish(compile(source("\ud800")).image), "read");
	const after = known(publish(compile(source("\ufffd")).image), "read");
	expect(after.origin).toBe(before.origin);
	expect(after.revision).not.toBe(before.revision);
});
