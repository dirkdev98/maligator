function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}
function nestedDeletion() {
	return eval("var value = 1; eval('[delete value, typeof value]')");
}
function redeclaration() {
	return eval(
		`var value = 1; eval('delete value; eval("var value"); [typeof value, delete value]')`,
	);
}
function escapedBindings() {
	const bindings = eval(
		`var value = 1; eval('[() => value, next => value = next, () => delete value]')`,
	);
	const before = bindings[0]();
	const removed = bindings[2]();
	const absent = observe(bindings[0]);
	eval("var value = 3");
	const recreated = bindings[0]();
	bindings[1](5);
	return [before, removed, absent, recreated, eval("value")];
}
function nestedAbrupt() {
	const thrown = {};
	let sameThrow = false;
	try {
		eval("var value = 1; eval('value = 7; throw thrown')");
	} catch (error) {
		sameThrow = error === thrown;
	}
	return [sameThrow, eval("value"), eval("delete value"), eval("typeof value")];
}
function ownFunctionVariables(arrow) {
	eval("var value = 1");
	const make = arrow
		? "seed => { eval('var value = seed'); return [() => value, next => value = next]; }"
		: "function (seed) { eval('var value = seed'); return [() => value, next => value = next]; }";
	const inner = eval(`(${make})`);
	const first = inner(2);
	const second = inner(3);
	first[1](4);
	return [first[0](), second[0](), eval("value")];
}
function parameterVariables(
	parameter = eval("var parameterBodyOnly = 7; parameterBodyOnly"),
) {
	var parameterBodyOnly = 3;
	return [parameter, parameterBodyOnly, typeof globalThis.parameterBodyOnly];
}
console.log(
	JSON.stringify({
		nestedDeletion: nestedDeletion(),
		redeclaration: redeclaration(),
		escapedBindings: escapedBindings(),
		nestedAbrupt: nestedAbrupt(),
		ordinaryFunction: ownFunctionVariables(false),
		arrowFunction: ownFunctionVariables(true),
		parameterVariables: parameterVariables(),
	}),
);
