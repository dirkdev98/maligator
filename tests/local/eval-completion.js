let passed = 0;

function check(name, source, expected) {
	const actual = (0, eval)(source);
	if (!Object.is(actual, expected)) {
		throw new Error("FAIL " + name + ": got " + actual);
	}
	passed++;
}

check("if false", "1; if (false) {}", undefined);
check("if valued", "1; if (true) { 2; }", 2);
check("if strict false", '"use strict"; 1; if (false) {}', undefined);

check("while no iteration", "1; while (false) {}", undefined);
check("while valued", "var n = 1; 1; while (n--) { 3; }", 3);
check("do while empty", "1; do {} while (false)", undefined);
check("do while valued", "1; do { 4; } while (false)", 4);
check("do while empty break", "1; do { break; } while (false)", undefined);
check("do while valued break", "1; do { 5; break; } while (false)", 5);

check("for no iteration", "1; for (; false; ) {}", undefined);
check("for valued", "var n = 1; 1; for (; n--; ) { 6; }", 6);
check("for-in no iteration", "var k; 1; for (k in {}) {}", undefined);
check("for-in valued", "var k; 1; for (k in { x: 0 }) { 7; }", 7);
check("for-of no iteration", "var v; 1; for (v of []) {}", undefined);
check("for-of valued", "var v; 1; for (v of [0]) { 8; }", 8);

check("switch no match", "1; switch (0) { case 1: 9; }", undefined);
check("switch valued", "1; switch (0) { case 0: 9; }", 9);
check("with empty", "1; with ({}) {}", undefined);
check("with valued", "1; with ({}) { 10; }", 10);

check("empty statement preserves", "11; ;", 11);
check("empty block preserves", "12; {}", 12);
check("declaration preserves", "13; var retained", 13);

const firstDynamic = Function("return 21;");
const secondDynamic = Function("return 21;");
if (firstDynamic === secondDynamic || firstDynamic() !== secondDynamic()) {
	throw new Error("FAIL cached Function source must create fresh closures");
}
passed++;

function readDirect(value) {
	return eval("value");
}
if (readDirect(31) !== 31 || readDirect(32) !== 32) {
	throw new Error("FAIL cached direct eval must use the current scope");
}
passed++;

function readCycled(value, selector) {
	if (selector === 0) return eval("value + 1");
	if (selector === 1) return eval("value + 2");
	if (selector === 2) return eval("value + 3");
	return eval("value + 4");
}
let cycledTotal = 0;
for (let i = 0; i < 32; i++) cycledTotal += readCycled(i, i % 4);
if (cycledTotal !== 576) {
	throw new Error("FAIL cycled cached eval must use the current scope");
}
passed++;

function createEvalState() {
	return eval("let state = 0; () => ++state");
}
const firstEvalState = createEvalState();
const secondEvalState = createEvalState();
if (
	firstEvalState() !== 1 ||
	firstEvalState() !== 2 ||
	secondEvalState() !== 1
) {
	throw new Error("FAIL cached eval must create fresh lexical bindings");
}
passed++;

const templateObjects = [];
function collectTemplateObject(templateObject) {
	templateObjects.push(templateObject);
}
for (let outer = 0; outer < 2; outer++) {
	eval(
		"(function () { for (let inner = 0; inner < 2; inner++) { " +
			"collectTemplateObject`${outer}${inner}`; } })();",
	);
}
if (
	templateObjects[0] !== templateObjects[1] ||
	templateObjects[1] === templateObjects[2] ||
	templateObjects[2] !== templateObjects[3]
) {
	throw new Error("FAIL separate eval calls must create fresh template sites");
}
passed++;

if (
	(0, eval)("let cachedLexical = 41; cachedLexical") !== 41 ||
	(0, eval)("let cachedLexical = 41; cachedLexical") !== 41
) {
	throw new Error("FAIL cached indirect eval must create fresh lexical state");
}
passed++;

for (let i = 0; i < 65536; i++) {
	if ((0, eval)("/* empty " + i + " */") !== undefined) {
		throw new Error("FAIL distinct empty eval completion");
	}
}
passed++;

const firstLiteralRegExp = eval("/a/");
const secondLiteralRegExp = eval("/a/");
if (
	firstLiteralRegExp === secondLiteralRegExp ||
	firstLiteralRegExp.source !== "a" ||
	Object.getPrototypeOf(firstLiteralRegExp) !== RegExp.prototype
) {
	throw new Error("FAIL eval regexp literal must create a fresh realm object");
}
passed++;

console.log("eval-completion PASS " + passed + "/" + passed);
