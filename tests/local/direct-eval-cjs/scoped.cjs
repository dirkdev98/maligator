// A CommonJS dependency whose direct evals read and write the bindings in scope,
// including the wrapper's module, exports and require.
const hot = require("./hot.cjs");

const originalExports = exports;
const originalRequire = require;
let moduleCounter = 0;
var shared = "start";
let tripled = hot.triple;

function numeric(value) {
	return value * 2 + 1;
}

// Feature detection in the style of older npm packages.
var supportsGenerators = (function () {
	try {
		eval("(function* () {})");
		return true;
	} catch (error) {
		return false;
	}
})();

function errorName(code) {
	try {
		return eval(code);
	} catch (error) {
		return error.name;
	}
}

function readWriteLocals(code) {
	let local = 1;
	const items = [1, 2, 3];
	const result = eval(code);
	return [local, items.length, result];
}

function bumpModule(step) {
	return eval("moduleCounter += step");
}

function wrapperBindings() {
	return [
		...eval(
			"[typeof module, typeof exports, typeof require, typeof __filename, typeof __dirname, " +
				"module.exports === exports, require === originalRequire]",
		),
		eval("__dirname") === __dirname,
		eval("__filename") === __filename,
	];
}

function exportThroughEval(name, value) {
	eval(
		"exports[name] = value; module.exports.viaModule = (module.exports.viaModule || 0) + 1",
	);
	return [exports[name], module.exports.viaModule];
}

function requireThroughEval() {
	return [errorName("require(0)"), errorName("require(1)"), errorName("require()")];
}

function rebindRequire() {
	const before = require;
	eval("require = function fake(id) { return 'fake:' + id; }");
	const fake = require.call(null, "unused");
	eval("require = before");
	return [fake, require === originalRequire];
}

function rebindTripled(code) {
	eval(code);
	return tripled(5);
}

function oddArguments() {
	let total = 0;
	for (let index = 0; index < 200; index++) total += numeric(index) + tripled(index);
	return [
		total,
		eval("numeric('x')"),
		eval("numeric(1, 2, 3)"),
		eval("tripled('ab')"),
		eval("tripled([7])"),
		eval("hot.restTotal('r', 1, [2])"),
	];
}

function defineVars() {
	return [
		eval("var fresh = 1; function made() { return fresh + 6; } made()"),
		eval("var shared = 'inner'; shared"),
	];
}

function strictVar() {
	"use strict";
	return [eval("var fresh = 1; fresh + 1"), typeof fresh];
}

function argumentsThroughEval(first) {
	return eval("arguments.length + ':' + arguments[0] + ':' + first");
}

function* evalSequence(seed) {
	let state = seed;
	yield eval("state");
	state += 10;
	yield eval("state++");
	yield state;
}

function restSeen(...values) {
	eval("values.push(values.length * 10)");
	let total = 0;
	for (const value of values) total += value;
	return total;
}

// Module-level, so every eval here can call it, but no eval sees its rest array.
function restUnseen(...values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function capturedSeen(values, code) {
	const head = () => values[0];
	const tail = () => values[values.length - 1];
	const seen = eval(code);
	if (!values) return 0;
	return [head() + tail(), seen];
}

function makeCounter() {
	let captured = 0;
	return {
		add(step) {
			captured += step;
			return captured;
		},
		peek: () => eval("captured"),
		poke: (code) => eval(code),
	};
}

class Vault {
	#secret = 3;
	#log = [];
	read() {
		return eval("this.#secret");
	}
	write(value) {
		eval("this.#secret = value; this.#log.push(value)");
	}
	secretTotal() {
		let total = 0;
		for (let index = 0; index < 10; index++) total += this.#secret + 1;
		return total;
	}
	logTotal() {
		let total = 0;
		for (let index = 0; index < this.#log.length; index++) total += this.#log[index];
		return total;
	}
}

const topLevel = [
	eval("this === module.exports"),
	(() => eval("this === exports"))(),
	(() => this === exports)(),
	eval("moduleCounter += 100"),
];
moduleCounter = 0;

module.exports = {
	argumentsThroughEval,
	bumpModule,
	capturedSeen,
	defineVars,
	evalSequence,
	exportThroughEval,
	makeCounter,
	oddArguments,
	readWriteLocals,
	rebindRequire,
	rebindTripled,
	requireThroughEval,
	restSeen,
	restUnseen,
	shared: () => shared,
	strictVar,
	supportsGenerators,
	topLevel,
	Vault,
	wrapperBindings,
	exportsReplaced: () => [module.exports !== originalExports, originalExports.viaModule],
};
