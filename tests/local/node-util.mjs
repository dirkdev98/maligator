import util, {
	deprecate,
	format,
	formatWithOptions,
	inherits,
	inspect,
	isArray,
	isBoolean,
	isBuffer,
	isFunction,
	isNull,
	isNullOrUndefined,
	isNumber,
	isObject,
	isString,
	isSymbol,
	isUndefined,
	parseArgs,
	promisify,
} from "node:util";

const { types } = util;

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(util.inspect === inspect, "default/named inspect identity");
check(util.inherits === inherits, "default/named inherits identity");
check(util.promisify === promisify, "default/named promisify identity");
check(util.parseArgs === parseArgs, "default/named parseArgs identity");
check(parseArgs.name === "parseArgs" && parseArgs.length === 0, "parseArgs metadata");
function callbackValue(value, callback) {
	callback(null, value * 2);
}
check((await promisify(callbackValue)(21)) === 42, "promisify fulfillment");
let rejection = "";
try {
	await promisify((callback) => callback(new Error("rejected")))();
} catch (error) {
	rejection = error.message;
}
check(rejection === "rejected", "promisify rejection");
check(format("hello %s %d %%", "world", 4) === "hello world 4 %", "format tokens");
check(format("extra", { value: 1 }) === "extra { value: 1 }", "format extras");
check(
	formatWithOptions({ depth: 0 }, "%O", { nested: { value: 1 } }) ===
		"{ nested: [Object] }",
	"format options depth",
);
check(inspect([1, "two"]) === "[ 1, 'two' ]", "array inspection");
check(inspect("quoted") === "'quoted'" && inspect({}) === "{}", "scalar inspection");
const legacyCases = [
	["isArray", isArray, [], true],
	["isBoolean", isBoolean, false, true],
	["isBuffer", isBuffer, Buffer.from("x"), true],
	["isFunction", isFunction, () => 1, true],
	["isNull", isNull, null, true],
	["isNullOrUndefined", isNullOrUndefined, undefined, true],
	["isNumber", isNumber, 1.5, true],
	["isObject", isObject, {}, true],
	["isString", isString, "node", true],
	["isSymbol", isSymbol, Symbol("node"), true],
	["isUndefined", isUndefined, undefined, true],
];
for (const [name, predicate, value, expected] of legacyCases) {
	check(predicate(value) === expected, `${name} positive`);
	check(predicate.name === name && predicate.length === 1, `${name} metadata`);
	check(util[name] === predicate, `${name} default/named identity`);
}
check(!isBuffer(new Uint8Array(1)), "isBuffer rejects plain Uint8Array");
check(!isObject(null) && !isObject(() => 1), "isObject follows legacy Node semantics");

const typeCases = [
	["isAnyArrayBuffer", new ArrayBuffer(1), true],
	["isArrayBuffer", new ArrayBuffer(1), true],
	["isSharedArrayBuffer", new SharedArrayBuffer(1), true],
	["isDataView", new DataView(new ArrayBuffer(2)), true],
	["isDate", new Date(), true],
	["isMap", new Map(), true],
	["isSet", new Set(), true],
	["isWeakMap", new WeakMap(), true],
	["isWeakSet", new WeakSet(), true],
	["isRegExp", /node/, true],
	["isTypedArray", new Uint8Array(1), true],
	["isBoxedPrimitive", Object(1), true],
	[
		"isGeneratorObject",
		(function* () {
			yield 1;
		})(),
		true,
	],
	["isProxy", new Proxy({}, {}), true],
	["isMapIterator", new Map().entries(), true],
	["isSetIterator", new Set().values(), true],
	["isInt8Array", new Int8Array(1), true],
	["isUint8Array", new Uint8Array(1), true],
	["isUint8ClampedArray", new Uint8ClampedArray(1), true],
	["isInt16Array", new Int16Array(1), true],
	["isUint16Array", new Uint16Array(1), true],
	["isInt32Array", new Int32Array(1), true],
	["isUint32Array", new Uint32Array(1), true],
	["isFloat32Array", new Float32Array(1), true],
	["isFloat64Array", new Float64Array(1), true],
	["isBigInt64Array", new BigInt64Array(1), true],
	["isBigUint64Array", new BigUint64Array(1), true],
];
for (const [name, value, expected] of typeCases) {
	check(types[name](value) === expected, `types.${name} positive`);
	check(types[name]({}) === false, `types.${name} negative`);
	check(types[name].length === 1, `types.${name} arity`);
}
check(types.isPromise(Promise.resolve()), "types.isPromise positive");
check(!types.isPromise({ then() {} }), "types.isPromise rejects thenables");
check(!types.isExternal({}), "types.isExternal rejects ordinary objects");
check(!types.isKeyObject({}), "types.isKeyObject rejects ordinary objects");
check(!types.isCryptoKey({}), "types.isCryptoKey rejects ordinary objects");
const circular = {};
circular.self = circular;
check(inspect(circular) === "{ self: [Circular] }", "cycle inspection");

const parsed = parseArgs({
	args: ["--verbose", "--name=maligator", "input", "--", "--literal"],
	options: {
		verbose: { type: "boolean" },
		name: { type: "string" },
	},
	allowPositionals: true,
	tokens: true,
});
check(Object.getPrototypeOf(parsed.values) === null, "parseArgs null-prototype values");
check(
	JSON.stringify(parsed.values) === '{"verbose":true,"name":"maligator"}',
	"parseArgs long values",
);
check(
	JSON.stringify(parsed.positionals) === '["input","--literal"]',
	"parseArgs positionals and terminator",
);
check(
	JSON.stringify(parsed.tokens) ===
		'[{"kind":"option","name":"verbose","rawName":"--verbose","index":0},{"kind":"option","name":"name","rawName":"--name","index":1,"value":"maligator","inlineValue":true},{"kind":"positional","index":2,"value":"input"},{"kind":"option-terminator","index":3},{"kind":"positional","index":4,"value":"--literal"}]',
	"parseArgs token details",
);

const grouped = parseArgs({
	args: ["-abfconfig.json", "-t", "one", "--tag=two"],
	options: {
		alpha: { type: "boolean", short: "a" },
		beta: { type: "boolean", short: "b" },
		file: { type: "string", short: "f" },
		tag: { type: "string", short: "t", multiple: true },
	},
	tokens: true,
});
check(
	JSON.stringify(grouped.values) ===
		'{"alpha":true,"beta":true,"file":"config.json","tag":["one","two"]}',
	"parseArgs short groups and repeated strings",
);
check(
	JSON.stringify(grouped.tokens) ===
		'[{"kind":"option","name":"alpha","rawName":"-a","index":0},{"kind":"option","name":"beta","rawName":"-b","index":0},{"kind":"option","name":"file","rawName":"-f","index":0,"value":"config.json","inlineValue":true},{"kind":"option","name":"tag","rawName":"-t","index":1,"value":"one","inlineValue":false},{"kind":"option","name":"tag","rawName":"--tag","index":3,"value":"two","inlineValue":true}]',
	"parseArgs grouped token indices",
);

const defaults = parseArgs({
	args: [],
	options: {
		name: { type: "string", default: "default-name" },
		color: { type: "boolean", default: true },
		tags: { type: "string", multiple: true, default: ["one", "two"] },
		flags: { type: "boolean", multiple: true, default: [true, false] },
	},
});
check(
	JSON.stringify(defaults.values) ===
		'{"name":"default-name","color":true,"tags":["one","two"],"flags":[true,false]}',
	"parseArgs typed defaults",
);
const negative = parseArgs({
	args: ["--feature", "--no-feature"],
	options: { feature: { type: "boolean" } },
	allowNegative: true,
	tokens: true,
});
check(negative.values.feature === false, "parseArgs negative boolean");
check(negative.tokens[1].name === "feature", "parseArgs normalizes negative token name");
const loose = parseArgs({ args: ["--unknown=value", "pos"], strict: false });
check(
	loose.values.unknown === "value" && loose.positionals[0] === "pos",
	"parseArgs loose unknown options and implied positionals",
);
check(parseArgs().positionals.length === 0, "parseArgs defaults to process argv slice");

const protoOptions = Object.create(null);
protoOptions.__proto__ = { type: "boolean", default: true };
const protoResult = parseArgs({ args: ["--__proto__"], options: protoOptions });
check(
	Object.getPrototypeOf(protoResult.values) === null &&
		!Object.hasOwn(protoResult.values, "__proto__"),
	"parseArgs blocks __proto__ storage",
);

function parseThrows(config) {
	try {
		parseArgs(config);
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}
function parseErrorCode(config) {
	try {
		parseArgs(config);
		return "";
	} catch (error) {
		return error.code;
	}
}
check(parseThrows({ args: "--bad" }), "parseArgs rejects non-array args");
check(
	parseErrorCode({ args: "--bad" }) === "ERR_INVALID_ARG_TYPE",
	"parseArgs invalid configuration error code",
);
check(parseThrows({ strict: 1 }), "parseArgs rejects non-boolean strict");
check(parseThrows({ options: [] }), "parseArgs rejects array options");
check(parseThrows({ options: { bad: {} } }), "parseArgs requires option type");
check(
	parseThrows({ options: { bad: { type: "number" } } }),
	"parseArgs rejects unknown option type",
);
check(
	parseThrows({ options: { bad: { type: "boolean", short: "bb" } } }),
	"parseArgs validates short names",
);
check(
	parseThrows({ options: { bad: { type: "boolean", multiple: 1 } } }),
	"parseArgs validates multiple",
);
check(
	parseThrows({ options: { bad: { type: "string", default: true } } }),
	"parseArgs validates defaults",
);
check(parseThrows({ args: ["--unknown"] }), "parseArgs rejects unknown options");
check(
	parseErrorCode({ args: ["--unknown"] }) === "ERR_PARSE_ARGS_UNKNOWN_OPTION",
	"parseArgs unknown option error code",
);
check(
	parseThrows({ args: ["--name"], options: { name: { type: "string" } } }),
	"parseArgs requires string option values",
);
check(
	parseErrorCode({
		args: ["--name"],
		options: { name: { type: "string" } },
	}) === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
	"parseArgs invalid option value error code",
);
check(
	parseThrows({
		args: ["--flag=yes"],
		options: { flag: { type: "boolean" } },
	}),
	"parseArgs rejects boolean option values",
);
check(parseThrows({ args: ["positional"] }), "parseArgs rejects strict positionals");
check(
	parseErrorCode({ args: ["positional"] }) === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
	"parseArgs unexpected positional error code",
);
check(
	parseThrows({
		args: ["--name", "--other"],
		options: { name: { type: "string" }, other: { type: "boolean" } },
	}),
	"parseArgs rejects ambiguous option-like values",
);

function Parent() {}
Parent.prototype.value = function () {
	return 7;
};
function Child() {}
inherits(Child, Parent);
const child = new Child();
check(child instanceof Child && child instanceof Parent, "inherits prototype chain");
check(Child.super_ === Parent && child.value() === 7, "inherits metadata and methods");

let calls = 0;
const wrapped = deprecate(function (value) {
	calls++;
	return this.base + value;
}, "test warning");
check(wrapped.call({ base: 2 }, 3) === 5, "deprecate forwards this and arguments");
check(wrapped.call({ base: 3 }, 4) === 7 && calls === 2, "deprecate remains callable");

function Legacy(value) {
	this.value = value;
}
const DeprecatedLegacy = deprecate(Legacy, "legacy warning");
const legacy = new DeprecatedLegacy(9);
check(
	legacy instanceof Legacy && legacy instanceof DeprecatedLegacy && legacy.value === 9,
	"deprecate preserves construction",
);

console.log("RESULT " + passed + "/" + total);
