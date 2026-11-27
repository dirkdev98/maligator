import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { primordialGlobalBindings } from "../../../src/compiler/shared/builtin-registry.ts";
import { noPrimordialMutation } from "../src/no-primordial-mutation.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const typescript = { languageOptions: { parserOptions: { lang: "ts" as const } } };

function locked(count = 1) {
	return Array.from({ length: count }, () => ({ messageId: "locked" }));
}

new RuleTester().run("no-primordial-mutation", noPrimordialMutation, {
	valid: [
		{
			name: "host objects and new globals stay writable",
			code: 'globalThis.config = {};\nprocess.exitCode = 1;\nconsole.log = () => {};\nObject.defineProperty(globalThis, "settings", { value: {} });',
		},
		{
			name: "Node's stack trace hooks accept assignment",
			code: "Error.stackTraceLimit = 50;\nError.prepareStackTrace = (error, frames) => frames;",
		},
		{
			name: "a local binding named like a built-in is not the built-in",
			code: "function install(Math) {\n\tMath.clamp = clamp;\n}\nconst Map = createMap();\nMap.prototype.extra = 1;",
		},
		{
			name: "reading built-ins or calling their methods on other receivers",
			code: 'const max = Math.max;\nArray.prototype.push.call(list, 1);\nObject.assign({}, defaults);\nReflect.set(target, "key", 1);',
		},
	],
	invalid: [
		{
			name: "replacing any primordial global",
			code: primordialGlobalBindings
				.map(({ name }) => `globalThis.${name} = value;`)
				.join("\n"),
			errors: primordialGlobalBindings.map(({ name }) => ({
				messageId: "locked",
				data: { target: `globalThis.${name}`, operation: "assignment" },
			})),
		},
		{
			name: "a helper added to a built-in",
			code: "Math.clamp = (value) => value;\nJSON.parseSafe = parse;",
			errors: locked(2),
		},
		{
			name: "a method added to a built-in prototype",
			code: 'Array.prototype.last = function () {};\nObject["prototype"]["extra"] = 1;',
			errors: locked(2),
		},
		{
			name: "a compound assignment or update",
			code: "Number.count += 1;\nMath.seed++;",
			errors: locked(2),
		},
		{
			name: "a delete, including of a stack trace hook",
			code: "delete Object.prototype.toString;\ndelete Error.stackTraceLimit;",
			errors: [
				{
					messageId: "locked",
					data: { target: "Object.prototype.toString", operation: "delete" },
				},
				{
					messageId: "locked",
					data: { target: "Error.stackTraceLimit", operation: "delete" },
				},
			],
		},
		{
			name: "a path through globalThis",
			code: "globalThis.Array.prototype.first = first;",
			errors: [
				{
					messageId: "locked",
					data: { target: "globalThis.Array.prototype.first", operation: "assignment" },
				},
			],
		},
		{
			name: "a reflected definition targets its first argument",
			code: 'Object.defineProperty(Array.prototype, "last", { get() {} });\nObject.assign(Math, helpers);\nReflect.setPrototypeOf(JSON, null);',
			errors: [
				{
					messageId: "locked",
					data: { target: "Array.prototype", operation: "`Object.defineProperty` call" },
				},
				{
					messageId: "locked",
					data: { target: "Math", operation: "`Object.assign` call" },
				},
				{
					messageId: "locked",
					data: { target: "JSON", operation: "`Reflect.setPrototypeOf` call" },
				},
			],
		},
		{
			name: "a primordial global defined or deleted through globalThis",
			code: 'Object.defineProperty(globalThis, "Promise", { value: CustomPromise });\nReflect.deleteProperty(globalThis, "JSON");',
			errors: [
				{
					messageId: "locked",
					data: {
						target: "globalThis.Promise",
						operation: "`Object.defineProperty` call",
					},
				},
				{
					messageId: "locked",
					data: { target: "globalThis.JSON", operation: "`Reflect.deleteProperty` call" },
				},
			],
		},
		{
			name: "an in-place array method called on Array.prototype itself",
			code: "Array.prototype.push(1);",
			errors: [
				{
					messageId: "locked",
					data: { target: "Array.prototype", operation: "`Array.prototype.push` call" },
				},
			],
		},
		{
			name: "type assertions are erased",
			code: '(Math as unknown as { clamp: unknown }).clamp = clamp;\nObject.prototype!.extra = 1;\nObject.defineProperty(Array.prototype as object, "last", {});',
			errors: locked(3),
			...typescript,
		},
	],
});
