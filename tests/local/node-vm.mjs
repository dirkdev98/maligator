import vm, {
	compileFunction,
	constants,
	createContext,
	isContext,
	runInContext,
	runInNewContext,
	runInThisContext,
	Script,
} from "node:vm";

function report(label, fn) {
	try {
		console.log(label, JSON.stringify(fn()));
	} catch (error) {
		// Engines word parse errors differently; only the class is portable.
		const message = error.name === "SyntaxError" ? "" : error.message;
		console.log(label, "throws", error.name, error.code ?? "-", message);
	}
}

report(
	"default identity",
	() => vm.Script === Script && vm.runInContext === runInContext,
);

report("this context completion", () => runInThisContext("6 * 7"));
runInThisContext(
	"var vmGlobalVar = 'var'; function vmGlobalFn() { return 'fn'; } let vmLexical = 'let';",
);
report("this context declarations", () => [
	globalThis.vmGlobalVar,
	typeof globalThis.vmGlobalFn === "function" && globalThis.vmGlobalFn(),
	runInThisContext("vmLexical"),
	Object.hasOwn(globalThis, "vmLexical"),
]);
report("this context coerces code", () => runInThisContext(5));
report("this context syntax error", () => runInThisContext("let = ;"));

const sandbox = { count: 1, items: [1, 2] };
report("createContext returns sandbox", () => createContext(sandbox) === sandbox);
report("isContext", () => [
	isContext(sandbox),
	isContext({}),
	isContext(createContext()),
]);
report("context reads and writes", () =>
	runInContext("count += 1; var created = 'yes'; items.push(3); typeof require", sandbox),
);
report("sandbox after run", () => [sandbox.count, sandbox.created, sandbox.items]);
report("context keeps state", () => runInContext("count + created.length", sandbox));
report("context isolates intrinsics", () => runInContext("Array", sandbox) !== Array);
report("context lexical stays private", () => {
	runInContext("const hidden = 1; globalThis.exposed = hidden + 1;", sandbox);
	return [Object.hasOwn(sandbox, "hidden"), sandbox.exposed];
});
report("context throw keeps writes", () => {
	try {
		runInContext("partial = 'kept'; throw new RangeError('boom')", sandbox);
	} catch (error) {
		return [error.message, sandbox.partial];
	}
	return "no throw";
});

report("new context with sandbox", () => {
	const fresh = { a: 2 };
	const result = runInNewContext("b = a * 10; a + b", fresh);
	return [result, fresh.b, isContext(fresh)];
});
report("new context default sandbox", () => runInNewContext("typeof globalThis.count"));

const script = new Script(
	"counter = (typeof counter === 'number' ? counter : 0) + 1; counter",
	{
		filename: "counter.js",
	},
);
report("script in this context", () => [
	script.runInThisContext(),
	script.runInThisContext(),
]);
const scriptContext = createContext({ counter: 10 });
report("script in context", () => [
	script.runInContext(scriptContext),
	script.runInContext(scriptContext),
	scriptContext.counter,
]);
report("script in new context", () => {
	const fresh = { counter: 100 };
	return [script.runInNewContext(fresh), fresh.counter, script.runInNewContext()];
});
report("script cached data", () => {
	const data = script.createCachedData();
	return [Buffer.isBuffer(data), data instanceof Uint8Array];
});
report("script syntax error at construction", () => new Script("var x = ;"));
report("createScript", () => vm.createScript("1 + 1").runInThisContext());

report("compileFunction", () => compileFunction("return a + b", ["a", "b"])(2, 3));
report("compileFunction no params", () => compileFunction("return typeof this")());
report("compileFunction parsing context", () => {
	const context = createContext({});
	const fn = compileFunction("return [] instanceof Array", [], {
		parsingContext: context,
	});
	const make = compileFunction("return []", [], { parsingContext: context });
	return [fn(), make() instanceof Array];
});

report("constants", () =>
	Object.entries(constants).map(([key, value]) => `${key}=${String(value)}`),
);

report("compileFunction code type", () => compileFunction(1));
report("compileFunction params type", () => compileFunction("", 1));
report("compileFunction param element", () => compileFunction("", [1]));
report("runInContext plain object", () => runInContext("1", {}));
report("runInContext primitive", () => runInContext("1", 1));
report("createContext primitive", () => createContext(1));
report("isContext primitive", () => isContext(1));
report("runInNewContext primitive", () => runInNewContext("1", 1));
report("Script without new", () => Script("1"));
