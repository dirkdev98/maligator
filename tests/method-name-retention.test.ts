import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { IMPLICITLY_CALLED_METHOD_NAMES } from "../src/compiler/core/core-method-reachability.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { hostInstallerSymbol } from "../src/compiler/frontend/host-modules.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";

const node = resolveBuildConfig({ surface: { node: true } });
const OS_INSTALLER = hostInstallerSymbol("node:os");
const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Whether a production build of `source` links the `node:os` installer. */
function retainsOs(source: string, config = node): boolean {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-method-retention-"));
	roots.push(root);
	const entry = path.join(root, "main.mjs");
	writeFileSync(entry, `import { hostname } from "node:os";\n${source}`);
	const image = compileEntrypoint(entry, {
		buildConfig: config,
		stripTypes: stripCompactTypes,
	});
	return image.runtime.hostInstalls.some(({ installer }) => installer === OS_INSTALLER);
}

const file = (member: string) =>
	`class File {\n\ttext() { return "text"; }\n\t${member}\n}\nconsole.log(new File().text());\n`;

describe("class method retention", () => {
	it("drops the host reads of a method nothing calls", () => {
		expect(retainsOs(file(`extra() { return hostname(); }`))).toBe(false);
	});

	it("drops a method named like a Proxy trap while the program builds no Proxy", () => {
		expect(retainsOs(file(`get(key) { return hostname() + key; }`))).toBe(false);
	});

	it.each([
		["a static member call", `console.log(new File().extra());`],
		["a destructured method", `const { extra } = File.prototype; console.log(extra());`],
		["a string literal key", `console.log(new File()["extra"]());`],
		["an `in` check", `console.log("extra" in File.prototype);`, false],
		["a computed key", `console.log(new File()[process.argv[2]]());`],
		["Reflect.get", `console.log(Reflect.get(File.prototype, process.argv[2]));`],
		[
			"a property descriptor",
			`console.log(Object.getOwnPropertyDescriptor(File.prototype, process.argv[2]));`,
		],
		[
			"enumerated prototype keys",
			`for (const key of Object.getOwnPropertyNames(File.prototype)) console.log(File.prototype[key]);`,
		],
		[
			"duck typing on another object",
			`for (const item of [{ extra: () => 1 }]) console.log(item.extra());`,
		],
	])("keeps an unused method's host reads for %s", (_name, use, retained = true) => {
		expect(retainsOs(`${file(`extra() { return hostname(); }`)}${use}\n`)).toBe(retained);
	});

	it("keeps a base method a subclass calls through super", () => {
		const source = `class Base {\n\textra() { return hostname(); }\n}\nclass Derived extends Base {\n\trun() { return super.extra(); }\n}\nconsole.log(new Derived().run());\n`;
		expect(retainsOs(source)).toBe(true);
	});

	it.each([
		["a getter", `get extra() { return hostname(); }`],
		["a symbol-keyed method", `[Symbol.iterator]() { return [hostname()].values(); }`],
		["a thenable", `then(resolve) { resolve(hostname()); }`],
		["a conversion", `toString() { return hostname(); }`],
	])("keeps %s the runtime calls implicitly", (_name, member) => {
		expect(retainsOs(file(member))).toBe(true);
	});

	it("keeps Proxy traps once the program builds a Proxy", () => {
		const source = `class Handler {\n\tget(target, key) { return hostname() + String(key); }\n}\nconsole.log(new Proxy({}, new Handler()).name);\n`;
		expect(retainsOs(source)).toBe(true);
	});

	it("keeps every method when run-time code can name any key", () => {
		const evaluating = resolveBuildConfig({
			surface: { node: true },
			engine: { eval: true },
		});
		expect(retainsOs(file(`extra() { return hostname(); }`), evaluating)).toBe(true);
	});

	it("treats every method a C host component calls by name as implicitly called", () => {
		const runtime = path.join(import.meta.dirname, "../runtime/src");
		const called = new Set<string>();
		for (const entry of readdirSync(runtime, { recursive: true, encoding: "utf8" })) {
			if (!entry.endsWith(".c")) continue;
			const source = readFileSync(path.join(runtime, entry), "utf8");
			// The method name is the string argument the call's own arguments follow.
			for (const [call] of source.matchAll(/\b\w*call_method\w*\([^;]*/g))
				for (const [, name] of call.matchAll(/"([A-Za-z_$][\w$]*)"\s*,/g))
					called.add(name!);
		}
		expect(called.size).toBeGreaterThan(0);
		expect(
			[...called].filter((name) => !IMPLICITLY_CALLED_METHOD_NAMES.has(name)),
		).toEqual([]);
	});
});
