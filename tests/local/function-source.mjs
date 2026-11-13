import assert from "node:assert/strict";

const render = Function.prototype.toString;

function spacing /* retained */(value) {
	return value + 1;
}
assert.equal(
	render.call(spacing),
	"function spacing /* retained */(value) {\n\treturn value + 1;\n}",
);
const first = function repeated() {
	return 1;
};
const second = function repeated() {
	return 2;
};
assert.equal(render.call(first), "function repeated() {\n\treturn 1;\n}");
assert.equal(render.call(second), "function repeated() {\n\treturn 2;\n}");
const arrow = (value /* comment */) => value + 2;
assert.equal(render.call(arrow), "(value /* comment */) => value + 2");
const unicode = function unicode() {
	return "🦎";
};
assert.equal(render.call(unicode), 'function unicode() {\n\treturn "🦎";\n}');

const methods = {
	async read(value) {
		return value;
	},
	*items() {
		yield 1;
	},
	get value() {
		return 3;
	},
	set value(input) {
		this.saved = input;
	},
	["computed"]() {
		return 4;
	},
};
assert.equal(render.call(methods.read), "async read(value) {\n\t\treturn value;\n\t}");
assert.equal(render.call(methods.items), "*items() {\n\t\tyield 1;\n\t}");
assert.equal(
	render.call(Object.getOwnPropertyDescriptor(methods, "value").get),
	"get value() {\n\t\treturn 3;\n\t}",
);
assert.equal(
	render.call(Object.getOwnPropertyDescriptor(methods, "value").set),
	"set value(input) {\n\t\tthis.saved = input;\n\t}",
);
assert.equal(render.call(methods.computed), '["computed"]() {\n\t\treturn 4;\n\t}');

class Explicit {
	constructor(value) {
		this.value = value;
	}
	static async /* outside method */ run() {
		return 5;
	}
	static() {
		return 6;
	}
}
assert.equal(
	render.call(Explicit),
	"class Explicit {\n\tconstructor(value) {\n\t\tthis.value = value;\n\t}\n\tstatic async /* outside method */ run() {\n\t\treturn 5;\n\t}\n\tstatic() {\n\t\treturn 6;\n\t}\n}",
);
assert.equal(
	render.call(Explicit.run),
	"async /* outside method */ run() {\n\t\treturn 5;\n\t}",
);
assert.equal(render.call(Explicit.prototype.static), "static() {\n\t\treturn 6;\n\t}");
class Implicit {
	method() {
		return 7;
	}
}
assert.equal(
	render.call(Implicit),
	"class Implicit {\n\tmethod() {\n\t\treturn 7;\n\t}\n}",
);
class Derived extends Implicit {
	method() {
		return 8;
	}
}
assert.equal(
	render.call(Derived),
	"class Derived extends Implicit {\n\tmethod() {\n\t\treturn 8;\n\t}\n}",
);

const indirectEval = eval;
const created = indirectEval(
	"(function evaluated (value) { /* retained */ return value; })",
);
assert.equal(
	render.call(created),
	"function evaluated (value) { /* retained */ return value; }",
);
const dynamic = new Function("value", "return value + 1;");
assert.equal(render.call(dynamic), "function anonymous(value\n) {\nreturn value + 1;\n}");
Object.defineProperty(first, "name", {
	get() {
		throw new Error("public name read");
	},
});
assert.equal(render.call(first), "function repeated() {\n\treturn 1;\n}");
assert.ok(render.call(second.bind(null)).includes("[native code]"));
const proxy = new Proxy(first, {
	get() {
		throw new Error("proxy inspected");
	},
});
assert.ok(render.call(proxy).includes("[native code]"));
assert.throws(() => render.call({}), TypeError);
if (typeof globalThis.gc === "function") globalThis.gc();
assert.equal(
	render.call(created),
	"function evaluated (value) { /* retained */ return value; }",
);
console.log("FUNCTION SOURCE PASS");
