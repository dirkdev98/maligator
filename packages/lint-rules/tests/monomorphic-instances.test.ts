import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { monomorphicInstances } from "../src/monomorphic-instances.ts";

RuleTester.describe = describe;
RuleTester.it = it;

function addedConditionally(output: string) {
	return {
		messageId: "addedConditionally",
		suggestions: [{ messageId: "declareField", output }],
	};
}

new RuleTester().run("monomorphic-instances", monomorphicInstances, {
	valid: [
		{
			name: "an instance method updates a declared field",
			code: "class C { cache; load() { this.cache = 1; } }",
		},
		{
			name: "an instance method updates a key initialized by the constructor",
			code: "class C { load() { this.cache = 1; } constructor() { this.cache = 0; } }",
		},
		{
			name: "a constructor assignment after a branch still initializes every instance",
			code: "class C { constructor(ready) { if (ready) this.cache = 1; this.cache = 2; } }",
		},
		{
			name: "both arms of a constructor branch initialize the key",
			code: "class C { constructor(ready) { if (ready) this.cache = 1; else this.cache = 2; } }",
		},
		{
			name: "an uncaught exception leaves no instance without the key",
			code: "class C { constructor() { try { this.cache = setup(); } finally { cleanup(); } } }",
		},
		{
			name: "a computed or private write is outside the rule",
			code: 'class C { #secret; load(key) { this.#secret = 1; this["fixed"] = 2; this[key] = 3; } }',
		},
		{
			name: "static members write to the class object",
			code: "class C { static { this.first = 1; } static load() { this.last = 2; } }",
		},
		{
			name: "an ordinary callback has its own this binding",
			code: "class C { load() { run(function () { this.cache = 1; }); } }",
		},
		{
			name: "assigning to an accessor calls its setter",
			code: "class C { set value(next) { use(next); } load() { this.value = 1; } }",
		},
		{
			name: "an imported base class may initialize the key",
			code: 'import { Base } from "./base.js"; class C extends Base { load() { this.cache = 1; } }',
		},
		{
			name: "an unresolved ancestor may initialize an inherited key",
			code: "class Base extends external.Base {} class C extends Base { load() { this.cache = 1; } }",
		},
		{
			name: "a constructor parameter property initializes the key",
			code: "class C { constructor(public cache = 0) {} load() { this.cache = 1; } }",
			filename: "test.ts",
		},
		{
			name: "a function constructor has no class field declaration to edit",
			code: "function F() { this.x = 1; } F.prototype.setY = function () { this.y = 2; };",
		},
	],
	invalid: [
		{
			name: "an instance method adds a key",
			code: "class C { static cache;\n\tload() { this.cache = 1; }\n}",
			errors: [
				addedConditionally(
					"class C { cache; static cache;\n\tload() { this.cache = 1; }\n}",
				),
			],
		},
		{
			name: "a constructor adds a key only in a branch",
			code: "class C {\n  constructor(ready) { if (ready) this.cache = 1; }\n}",
			errors: [
				addedConditionally(
					"class C {\n  cache;\n  constructor(ready) { if (ready) this.cache = 1; }\n}",
				),
			],
		},
		{
			name: "a constructor argument expression can be skipped by an optional chain",
			code: "class C { constructor(options) { options?.notify(this.loaded = true); } }",
			errors: [
				addedConditionally(
					"class C { loaded; constructor(options) { options?.notify(this.loaded = true); } }",
				),
			],
		},
		{
			name: "a constructor adds a key only in a loop that may not run",
			code: "class C { constructor(items) { for (const item of items) this.last = item; } }",
			errors: [
				addedConditionally(
					"class C { last; constructor(items) { for (const item of items) this.last = item; } }",
				),
			],
		},
		{
			name: "a constructor adds a key only on failure",
			code: "class C { constructor() { try { run(); } catch { this.failed = true; } } }",
			errors: [
				addedConditionally(
					"class C { failed; constructor() { try { run(); } catch { this.failed = true; } } }",
				),
			],
		},
		{
			name: "a constructor arrow callback captures the instance",
			code: "class C { constructor() { later(() => { this.cache = 1; }); } }",
			errors: [
				addedConditionally(
					"class C { cache; constructor() { later(() => { this.cache = 1; }); } }",
				),
			],
		},
		{
			name: "an arrow field captures the instance for a later callback",
			code: "class C { update = () => { this.cache = 1; }; }",
			errors: [
				addedConditionally("class C { cache; update = () => { this.cache = 1; }; }"),
			],
		},
		{
			name: "instance accessors add undeclared keys",
			code: "class C { get status() { this.read = true; return 1; } set status(n) { this.last = n; } }",
			errors: [
				addedConditionally(
					"class C { read; get status() { this.read = true; return 1; } set status(n) { this.last = n; } }",
				),
				addedConditionally(
					"class C { last; get status() { this.read = true; return 1; } set status(n) { this.last = n; } }",
				),
			],
		},
		{
			name: "a derived class adds a key its local base does not initialize",
			code: "class Base { flag; constructor() { this.value = 1; } } class C extends Base { load() { this.flag = true; this.value = 2; this.cache = 3; } }",
			errors: [
				addedConditionally(
					"class Base { flag; constructor() { this.value = 1; } } class C extends Base { cache; load() { this.flag = true; this.value = 2; this.cache = 3; } }",
				),
			],
		},
		{
			name: "a stable local class expression can be a base",
			code: "const Base = class { cache; }; class C extends Base { load() { this.cache = 1; this.last = 2; } }",
			errors: [
				addedConditionally(
					"const Base = class { cache; }; class C extends Base { last; load() { this.cache = 1; this.last = 2; } }",
				),
			],
		},
	],
});
