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

function initializeInConstructor(output: string) {
	return {
		messageId: "addedOutsideConstructor",
		suggestions: [{ messageId: "initializeInConstructor", output }],
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
			name: "a prototype method updates a key initialized in both branches",
			code: "function F(ready) { if (ready) this.x = 1; else this.x = 2; } F.prototype.update = function () { this.x = 3; };",
		},
		{
			name: "an ordinary function with an unrelated same-name constructor keeps its own receiver",
			code: "function F(flag) { if (flag) this.x = 1; } { function F() {} new F(); }",
		},
		{
			name: "an ordinary callback in a prototype method has its own receiver",
			code: "function F() {} F.prototype.update = function () { run(function () { this.x = 1; }); };",
		},
		{
			name: "an arrow stored on a prototype captures the surrounding receiver",
			code: "function F() {} F.prototype.update = () => { this.x = 1; };",
		},
		{
			name: "borrowing one prototype method makes the constructor's receiver ambiguous",
			code: "function F() {} F.prototype.update = function () { this.x = 1; }; F.prototype.read = function () {}; F.prototype.read.call(other);",
		},
		{
			name: "a method alias can be applied to a different receiver",
			code: "function F() {} F.prototype.update = function () { this.x = 1; }; const applyUpdate = F.prototype.update; applyUpdate.apply(other, []);",
		},
		{
			name: "a reassigned function binding has an unknown constructor",
			code: "function F(flag) { if (flag) this.x = 1; } F.prototype.update = function () { this.y = 1; }; F = other; new F();",
		},
		{
			name: "a key defined by a descriptor is outside the rule",
			code: 'function F() { Object.defineProperty(this, "x", { writable: true }); } F.prototype.update = function () { this.x = 1; };',
		},
		{
			name: "computed writes in prototype methods are outside the rule",
			code: 'function F() {} F.prototype.update = function (key) { this["y"] = 2; this[key] = 3; };',
		},
		{
			name: "the constructor copies a key into every instance",
			code: "function F() { Object.assign(this, { x: 0 }); } F.prototype.update = function () { this.x = 1; };",
		},
		{
			name: "the constructor's own write and its initializer method cover both branches",
			code: "function F(ready) { if (ready) this.x = 0; else this.init(); } F.prototype.init = function () { this.x = 1; };",
		},
		{
			name: "writing to a prototype setter calls it instead of adding a key",
			code: "function F() {} F.prototype = { set x(value) { use(value); }, update() { this.x = 1; } };",
		},
		{
			name: "a visible ancestor's constructor initializes the prototype method's key",
			code: 'const util = require("node:util"); function Base() { this.x = 0; } function Parent() { Base.call(this); } util.inherits(Parent, Base); function Child() { Parent.call(this); } Object.setPrototypeOf(Child.prototype, Parent.prototype); Child.prototype.update = function () { this.x = 1; };',
		},
		{
			name: "an unresolved ancestor may have initialized the key",
			code: 'import { inherits as link } from "node:util"; function Parent() {} link(Parent, imported.Parent); function Child() {} Object.setPrototypeOf(Child.prototype, Parent.prototype); Child.prototype.update = function () { this.x = 1; };',
		},
		{
			name: "an inherited prototype method can be borrowed through the child prototype",
			code: "function Base() {} Base.prototype.update = function () { this.x = 1; }; function Child() {} Object.setPrototypeOf(Child.prototype, Base.prototype); Child.prototype.update.call(other);",
		},
		{
			name: "an exception before a write cannot return an instance without the key",
			code: "function F(ready) { if (!ready) throw new Error(); this.x = 1; } F.prototype.update = function () { this.x = 2; };",
		},
		{
			name: "a constructor can return a different object",
			code: "function F(ready) { if (ready) this.x = 1; return {}; } new F();",
		},
	],
	invalid: [
		{
			name: "a prototype function adds a new key even when borrowed by a known instance",
			code: "function F() { this.x = 1; } F.prototype.update = function () { this.y = 2; }; const f = new F(); F.prototype.update.call(f);",
			errors: [
				initializeInConstructor(
					"function F() { this.y = undefined; this.x = 1; } F.prototype.update = function () { this.y = 2; }; const f = new F(); F.prototype.update.call(f);",
				),
			],
		},
		{
			name: "a prototype literal method captures the receiver in an arrow",
			code: "const F = function () {}; F.prototype = { update() { run(() => { this.x = 1; }); } };",
			errors: [
				initializeInConstructor(
					"const F = function () { this.x = undefined; }; F.prototype = { update() { run(() => { this.x = 1; }); } };",
				),
			],
		},
		{
			name: "Object.assign installs a prototype method and the suggestion preserves directives",
			code: 'function F() {\n\t"use strict"\n\tthis.x = 1;\n}\nObject.assign(F.prototype, { update() { this.y = 2; } });',
			errors: [
				initializeInConstructor(
					'function F() {\n\t"use strict"\n\tthis.y = undefined;\n\tthis.x = 1;\n}\nObject.assign(F.prototype, { update() { this.y = 2; } });',
				),
			],
		},
		{
			name: "a call with new identifies a constructor with a conditional write",
			code: "function F(ready) { if (ready) this.x = 1; } new F(false);",
			errors: [
				initializeInConstructor(
					"function F(ready) { this.x = undefined; if (ready) this.x = 1; } new F(false);",
				),
			],
		},
		{
			name: "an early return can bypass a later constructor write",
			code: "function F(ready) { if (!ready) return; this.x = 1; } new F(false);",
			errors: [
				initializeInConstructor(
					"function F(ready) { this.x = undefined; if (!ready) return; this.x = 1; } new F(false);",
				),
			],
		},
		{
			name: "a caught error can bypass the write in its assignment expression",
			code: "function F() { try { this.x = read(); } catch { handle(); } } new F();",
			errors: [
				initializeInConstructor(
					"function F() { this.x = undefined; try { this.x = read(); } catch { handle(); } } new F();",
				),
			],
		},
		{
			name: "a visible parent does not hide a child-only key",
			code: 'const { inherits } = require("util"); function Parent() { this.x = 1; } function Child() { Parent.call(this); } inherits(Child, Parent); Child.prototype.update = function () { this.x = 2; this.y = 3; };',
			errors: [
				initializeInConstructor(
					'const { inherits } = require("util"); function Parent() { this.x = 1; } function Child() { this.y = undefined; Parent.call(this); } inherits(Child, Parent); Child.prototype.update = function () { this.x = 2; this.y = 3; };',
				),
			],
		},
		{
			name: "a constructor parameter can shadow undefined",
			code: "function F(undefined) { if (undefined) this.x = 1; } new F(false);",
			errors: [
				initializeInConstructor(
					"function F(undefined) { this.x = void 0; if (undefined) this.x = 1; } new F(false);",
				),
			],
		},
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
