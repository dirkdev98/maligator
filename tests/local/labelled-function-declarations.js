function same(actual, expected) {
	if (actual !== expected) throw new Error("Expected " + expected + ", got " + actual);
}

same(topLevel(), 7);
label: function topLevel() {
	return 7;
}

function duplicates() {
	const initial = selected;
	same(selected(), 3);
	function selected() {
		return 1;
	}
	first: function selected() {
		return 2;
	}
	second: third: function selected() {
		return 3;
	}
	same(selected, initial);
	return selected();
}
same(duplicates(), 3);

function lexicalRead() {
	let caught = false;
	try {
		reader();
	} catch (error) {
		caught = error instanceof ReferenceError;
	}
	same(caught, true);
	const value = 11;
	declaration: function reader() {
		return value;
	}
	return reader();
}
same(lexicalRead(), 11);

function blockMirror() {
	same(typeof inner, "undefined");
	let initial;
	{
		initial = inner;
		same(inner(), 13);
		block: function inner() {
			return 13;
		}
		same(inner, initial);
	}
	same(inner, initial);
	return inner();
}
same(blockMirror(), 13);

function switchScope() {
	switch (0) {
		case 0:
			same(inCase(), 17);
		case 1:
			caseLabel: function inCase() {
				return 17;
			}
	}
}
switchScope();
function switchLexicalRead() {
	switch (0) {
		case 0: {
			let caught = false;
			try {
				read();
			} catch (error) {
				caught = error instanceof ReferenceError;
			}
			same(caught, true);
			break;
		}
		case 1:
			const value = 29;
			label: function read() {
				return value;
			}
	}
	same(typeof read, "undefined");
}
switchLexicalRead();
same(
	Function(
		"source",
		"return eval(source)",
	)(
		"switch (1) { case 1: if (f() !== 23) throw Error(); case 2: label: function f() { return 23; } } f()",
	),
	23,
);
same(topLevel.toString().startsWith("function topLevel("), true);
same(Function("return inner(); before: after: function inner() { return 19; }")(), 19);
for (const source of [
	'"use strict"; label: function forbidden() {}',
	'function outer() { "use strict"; label: function forbidden() {} }',
]) {
	let rejected = false;
	try {
		Function(source);
	} catch (error) {
		rejected = error instanceof SyntaxError;
	}
	same(rejected, true);
}
console.log("labelled-function-declarations PASS");
