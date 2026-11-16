function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return { error: error.name };
	}
}
function withReadAndCall() {
	const object = {
		value: 2,
		method() {
			"use strict";
			return this === object;
		},
	};
	with (object) {
		return eval("[value, method()]");
	}
}
function lexicalOrder() {
	let value = 1;
	const outer = { value: 2 };
	const inner = { value: 3 };
	const result = [];
	with (outer) {
		result.push(eval("value"));
		{
			let value = 4;
			result.push(eval("value"));
			with (inner) {
				result.push(eval("value"));
			}
		}
	}
	return [result, value];
}
function unscopables() {
	let value = 1;
	const object = { value: 2, [Symbol.unscopables]: { value: false } };
	with (object) {
		return eval("[value, (object[Symbol.unscopables].value = true), value]");
	}
}
function proxyLookup() {
	const log = [];
	const object = new Proxy(
		{ value: 2 },
		{
			has(target, key) {
				log.push(["has", String(key)]);
				return Reflect.has(target, key);
			},
			get(target, key, receiver) {
				log.push(["get", String(key)]);
				return Reflect.get(target, key, receiver);
			},
		},
	);
	function run() {
		with (object) {
			return eval("value");
		}
	}
	const value = run();
	return [value, log];
}
function primitiveEntry() {
	Object.defineProperty(String.prototype, "entryReceiver", {
		configurable: true,
		value: function () {
			"use strict";
			return this;
		},
	});
	try {
		let first, read;
		with ("abc") {
			first = eval("entryReceiver()");
			read = eval("() => entryReceiver()");
		}
		return [typeof first, first.valueOf(), first === read()];
	} finally {
		delete String.prototype.entryReceiver;
	}
}
function repeatedEntries() {
	const reads = [];
	for (let index = 0; index < 3; index++) {
		with ({ value: index }) {
			reads.push(eval("() => value"));
		}
	}
	return reads.map((read) => read());
}
function overriddenEval() {
	const object = {
		eval() {
			"use strict";
			return this === object;
		},
	};
	with (object) {
		return eval("ignored");
	}
}
function callerThis() {
	const receiver = {};
	function run() {
		with ({ value: 3 }) {
			return eval("[this === receiver, value]");
		}
	}
	return run.call(receiver);
}
function persistentShadowing() {
	return eval("var value = 1; { let value = 2; eval('value'); }");
}
function ownVariableReceiver() {
	const run = eval(`(function () {
		eval('var method = function () { "use strict"; return this; }');
		return method() === undefined;
	})`);
	return run();
}
function varInitializer() {
	const object = { value: 0 };
	with (object) {
		eval("var value = 1");
	}
	return [object.value, eval("value")];
}
function capturedInitializerReference() {
	const object = { value: 0 };
	with (object) {
		eval("var value = (delete object.value, 5)");
	}
	return [object.value, eval("value")];
}
function newFunctionDeclaration() {
	const object = { value: 3 };
	with (object) {
		eval("function value() { return 5; }");
	}
	return [object.value, eval("value()")];
}
function existingFunctionDeclaration() {
	var value = 1;
	const object = { value: 3 };
	with (object) {
		eval("function value() { return 5; }");
	}
	return [object.value, value()];
}
function globalNestedDeclaration() {
	try {
		(0, eval)(`eval('eval("var orderedGlobalValue = 7")')`);
		return [globalThis.orderedGlobalValue, delete globalThis.orderedGlobalValue];
	} finally {
		delete globalThis.orderedGlobalValue;
	}
}
function parameterBodyRecords(value = 1, read = () => value) {
	eval("var value = 2");
	return [read(), value, eval("value")];
}
function withEnteredByEval() {
	const object = { value: 7 };
	return eval("with (object) { eval('value'); }");
}
function sourceClosureCapturesEntry() {
	const reads = [];
	for (let index = 0; index < 3; index++) {
		with ({ value: index }) {
			reads.push(() => eval("value"));
		}
	}
	return reads.map((read) => read());
}
function nestedEvalClosureCapturesEntry() {
	const reads = [];
	for (let index = 0; index < 3; index++) {
		with ({ value: index }) {
			reads.push(eval("() => eval('value')"));
		}
	}
	return reads.map((read) => read());
}
function inheritedVariableDeletion() {
	globalThis.inheritedEvalValue = 42;
	try {
		const run = eval(`var inheritedEvalValue = 1;
			function run(action) {
				if (action === 'delete') return eval('delete inheritedEvalValue');
				return inheritedEvalValue;
			}
			run;`);
		return [run("read"), run("delete"), run("read"), globalThis.inheritedEvalValue];
	} finally {
		delete globalThis.inheritedEvalValue;
	}
}
function hoistedFunctionInsideWith() {
	with ({ value: 9 }) {
		return read();
		function read() {
			return eval("value");
		}
	}
}
function classMethodInsideWith() {
	let reader;
	with ({ value: 11 }) {
		class Reader {
			read() {
				return eval("value");
			}
		}
		reader = new Reader();
	}
	return reader.read();
}
const cases = {
	withReadAndCall,
	lexicalOrder,
	unscopables,
	proxyLookup,
	primitiveEntry,
	repeatedEntries,
	overriddenEval,
	callerThis,
	persistentShadowing,
	ownVariableReceiver,
	varInitializer,
	capturedInitializerReference,
	newFunctionDeclaration,
	existingFunctionDeclaration,
	globalNestedDeclaration,
	parameterBodyRecords,
	withEnteredByEval,
	sourceClosureCapturesEntry,
	nestedEvalClosureCapturesEntry,
	inheritedVariableDeletion,
	hoistedFunctionInsideWith,
	classMethodInsideWith,
};
const results = {};
for (const key of Object.keys(cases)) results[key] = observe(cases[key]);
console.log(JSON.stringify(results));
