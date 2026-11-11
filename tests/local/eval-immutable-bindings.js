"use strict";

let checks = 0;
let passed = 0;

function check(name, condition) {
	checks++;
	if (condition) passed++;
	else console.log(`FAIL ${name}`);
}

function throwsTypeError(run) {
	try {
		run();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

// A named function expression's own name is an immutable binding: strict eval
// code that assigns it throws, whichever assignment form reaches it.
const named = function Named() {
	check(
		"plain assignment",
		throwsTypeError(() => eval("Named = 1")),
	);
	check(
		"compound assignment",
		throwsTypeError(() => eval("Named += 1")),
	);
	check(
		"update",
		throwsTypeError(() => eval("Named++")),
	);
	check(
		"destructuring",
		throwsTypeError(() => eval("[Named] = [1]")),
	);
	check(
		"for-of head",
		throwsTypeError(() => eval("for (Named of [1]);")),
	);
	return typeof Named;
};
check("own name unchanged", named() === "function");

function constants() {
	const fixed = 1;
	check(
		"const assignment",
		throwsTypeError(() => eval("fixed = 2")),
	);
	check(
		"const update",
		throwsTypeError(() => eval("fixed++")),
	);
	check("const unchanged", fixed === 1);
	let mutable = 1;
	eval("mutable = 5");
	check("let written back", mutable === 5);
}
constants();

console.log(`eval-immutable-bindings PASS ${passed}/${checks}`);
