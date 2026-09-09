function check(value, message) {
	if (!value) throw new Error(message);
}

const functionReads = [
	[() => BigInt.asUintN, BigInt, "asUintN"],
	[() => BigInt.asIntN, BigInt, "asIntN"],
	[() => BigInt.prototype.toString, BigInt.prototype, "toString"],
	[() => BigInt.prototype.valueOf, BigInt.prototype, "valueOf"],
	[() => Boolean.prototype.toString, Boolean.prototype, "toString"],
	[() => Boolean.prototype.valueOf, Boolean.prototype, "valueOf"],
	[() => Math.abs, Math, "abs"],
	[() => Math.floor, Math, "floor"],
	[() => Math.ceil, Math, "ceil"],
	[() => Math.round, Math, "round"],
	[() => Math.trunc, Math, "trunc"],
	[() => Math.sqrt, Math, "sqrt"],
	[() => Math.cbrt, Math, "cbrt"],
	[() => Math.sign, Math, "sign"],
	[() => Math.log, Math, "log"],
	[() => Math.log2, Math, "log2"],
	[() => Math.log10, Math, "log10"],
	[() => Math.exp, Math, "exp"],
	[() => Math.sin, Math, "sin"],
	[() => Math.cos, Math, "cos"],
	[() => Math.tan, Math, "tan"],
	[() => Math.asin, Math, "asin"],
	[() => Math.acos, Math, "acos"],
	[() => Math.atan, Math, "atan"],
	[() => Math.sinh, Math, "sinh"],
	[() => Math.cosh, Math, "cosh"],
	[() => Math.tanh, Math, "tanh"],
	[() => Math.asinh, Math, "asinh"],
	[() => Math.acosh, Math, "acosh"],
	[() => Math.atanh, Math, "atanh"],
	[() => Math.log1p, Math, "log1p"],
	[() => Math.expm1, Math, "expm1"],
	[() => Math.fround, Math, "fround"],
	[() => Math.f16round, Math, "f16round"],
	[() => Math.clz32, Math, "clz32"],
	[() => Math.imul, Math, "imul"],
	[() => Math.atan2, Math, "atan2"],
	[() => Math.pow, Math, "pow"],
	[() => Math.hypot, Math, "hypot"],
	[() => Math.min, Math, "min"],
	[() => Math.max, Math, "max"],
	[() => Math.sumPrecise, Math, "sumPrecise"],
	[() => Math.random, Math, "random"],
	[() => Number.isNaN, Number, "isNaN"],
	[() => Number.isFinite, Number, "isFinite"],
	[() => Number.isInteger, Number, "isInteger"],
	[() => Number.isSafeInteger, Number, "isSafeInteger"],
	[() => Number.parseInt, Number, "parseInt"],
	[() => Number.parseFloat, Number, "parseFloat"],
	[() => Number.prototype.toString, Number.prototype, "toString"],
	[() => Number.prototype.toFixed, Number.prototype, "toFixed"],
	[() => Number.prototype.toExponential, Number.prototype, "toExponential"],
	[() => Number.prototype.toPrecision, Number.prototype, "toPrecision"],
	[() => Number.prototype.valueOf, Number.prototype, "valueOf"],
	[() => String.fromCharCode, String, "fromCharCode"],
	[() => String.fromCodePoint, String, "fromCodePoint"],
	[() => String.raw, String, "raw"],
	[() => String.prototype.charAt, String.prototype, "charAt"],
	[() => String.prototype.charCodeAt, String.prototype, "charCodeAt"],
	[() => String.prototype.codePointAt, String.prototype, "codePointAt"],
	[() => String.prototype.at, String.prototype, "at"],
	[() => String.prototype.indexOf, String.prototype, "indexOf"],
	[() => String.prototype.lastIndexOf, String.prototype, "lastIndexOf"],
	[() => String.prototype.includes, String.prototype, "includes"],
	[() => String.prototype.startsWith, String.prototype, "startsWith"],
	[() => String.prototype.endsWith, String.prototype, "endsWith"],
	[() => String.prototype.slice, String.prototype, "slice"],
	[() => String.prototype.substring, String.prototype, "substring"],
	[() => String.prototype.substr, String.prototype, "substr"],
	[() => String.prototype.anchor, String.prototype, "anchor"],
	[() => String.prototype.big, String.prototype, "big"],
	[() => String.prototype.blink, String.prototype, "blink"],
	[() => String.prototype.bold, String.prototype, "bold"],
	[() => String.prototype.fixed, String.prototype, "fixed"],
	[() => String.prototype.fontcolor, String.prototype, "fontcolor"],
	[() => String.prototype.fontsize, String.prototype, "fontsize"],
	[() => String.prototype.italics, String.prototype, "italics"],
	[() => String.prototype.link, String.prototype, "link"],
	[() => String.prototype.small, String.prototype, "small"],
	[() => String.prototype.strike, String.prototype, "strike"],
	[() => String.prototype.sub, String.prototype, "sub"],
	[() => String.prototype.sup, String.prototype, "sup"],
	[() => String.prototype.concat, String.prototype, "concat"],
	[() => String.prototype.localeCompare, String.prototype, "localeCompare"],
	[() => String.prototype.normalize, String.prototype, "normalize"],
	[() => String.prototype.repeat, String.prototype, "repeat"],
	[() => String.prototype.trim, String.prototype, "trim"],
	[() => String.prototype.trimStart, String.prototype, "trimStart"],
	[() => String.prototype.trimEnd, String.prototype, "trimEnd"],
	[() => String.prototype.trimLeft, String.prototype, "trimLeft"],
	[() => String.prototype.trimRight, String.prototype, "trimRight"],
	[() => String.prototype.toUpperCase, String.prototype, "toUpperCase"],
	[() => String.prototype.toLowerCase, String.prototype, "toLowerCase"],
	[() => String.prototype.toLocaleUpperCase, String.prototype, "toLocaleUpperCase"],
	[() => String.prototype.toLocaleLowerCase, String.prototype, "toLocaleLowerCase"],
	[() => String.prototype.isWellFormed, String.prototype, "isWellFormed"],
	[() => String.prototype.toWellFormed, String.prototype, "toWellFormed"],
	[() => String.prototype.split, String.prototype, "split"],
	[() => String.prototype.replace, String.prototype, "replace"],
	[() => String.prototype.replaceAll, String.prototype, "replaceAll"],
	[() => String.prototype.padStart, String.prototype, "padStart"],
	[() => String.prototype.padEnd, String.prototype, "padEnd"],
	[() => String.prototype.toString, String.prototype, "toString"],
	[() => String.prototype.valueOf, String.prototype, "valueOf"],
	[() => Symbol.for, Symbol, "for"],
	[() => Symbol.keyFor, Symbol, "keyFor"],
	[() => Symbol.prototype.toString, Symbol.prototype, "toString"],
	[() => Symbol.prototype.valueOf, Symbol.prototype, "valueOf"],
	[() => Symbol.prototype[Symbol.toPrimitive], Symbol.prototype, Symbol.toPrimitive],
	[() => globalThis.parseInt, globalThis, "parseInt"],
	[() => globalThis.parseFloat, globalThis, "parseFloat"],
	[() => globalThis.isNaN, globalThis, "isNaN"],
	[() => globalThis.isFinite, globalThis, "isFinite"],
	[() => globalThis.decodeURI, globalThis, "decodeURI"],
	[() => globalThis.decodeURIComponent, globalThis, "decodeURIComponent"],
	[() => globalThis.encodeURI, globalThis, "encodeURI"],
	[() => globalThis.encodeURIComponent, globalThis, "encodeURIComponent"],
	[() => globalThis.escape, globalThis, "escape"],
	[() => globalThis.unescape, globalThis, "unescape"],
];

const dataReads = [
	...functionReads,
	[() => Math.PI, Math, "PI"],
	[() => Math.E, Math, "E"],
	[() => Math.LN2, Math, "LN2"],
	[() => Math.LN10, Math, "LN10"],
	[() => Math.LOG2E, Math, "LOG2E"],
	[() => Math.LOG10E, Math, "LOG10E"],
	[() => Math.SQRT2, Math, "SQRT2"],
	[() => Math.SQRT1_2, Math, "SQRT1_2"],
	[() => Number.MAX_SAFE_INTEGER, Number, "MAX_SAFE_INTEGER"],
	[() => Number.MIN_SAFE_INTEGER, Number, "MIN_SAFE_INTEGER"],
	[() => Number.EPSILON, Number, "EPSILON"],
	[() => Number.MAX_VALUE, Number, "MAX_VALUE"],
	[() => Number.MIN_VALUE, Number, "MIN_VALUE"],
	[() => Number.POSITIVE_INFINITY, Number, "POSITIVE_INFINITY"],
	[() => Number.NEGATIVE_INFINITY, Number, "NEGATIVE_INFINITY"],
	[() => Number.NaN, Number, "NaN"],
	[() => Symbol.iterator, Symbol, "iterator"],
	[() => Symbol.asyncIterator, Symbol, "asyncIterator"],
	[() => Symbol.toStringTag, Symbol, "toStringTag"],
	[() => Symbol.hasInstance, Symbol, "hasInstance"],
	[() => Symbol.toPrimitive, Symbol, "toPrimitive"],
	[() => Symbol.species, Symbol, "species"],
	[() => Symbol.isConcatSpreadable, Symbol, "isConcatSpreadable"],
	[() => Symbol.match, Symbol, "match"],
	[() => Symbol.matchAll, Symbol, "matchAll"],
	[() => Symbol.replace, Symbol, "replace"],
	[() => Symbol.search, Symbol, "search"],
	[() => Symbol.split, Symbol, "split"],
	[() => Symbol.unscopables, Symbol, "unscopables"],
	[() => Symbol.dispose, Symbol, "dispose"],
	[() => Symbol.asyncDispose, Symbol, "asyncDispose"],
];

function* suspendedDataRead(read, escape) {
	const first = read();
	yield escape(first);
	if (typeof globalThis.gc === "function") globalThis.gc();
	return read();
}

for (const [read, owner, key] of dataReads) {
	const expected = Object.getOwnPropertyDescriptor(owner, key).value;
	const retained = [];
	for (let index = 0; index < 4; index++) retained.push(read());
	check(
		retained.every((value) => Object.is(value, expected)),
		"data read identity across loop",
	);
	const suspended = suspendedDataRead(read, (value) => {
		retained.push(value);
		return retained.length;
	});
	const yielded = suspended.next();
	check(yielded.value === 5 && !yielded.done, "data read escape before suspension");
	check(Object.is(retained[4], expected), "data read retains the installed value");
	const resumed = suspended.next();
	check(
		resumed.done && Object.is(resumed.value, expected),
		"data read identity after suspension",
	);
	const events = [];
	const sentinel = {};
	const proxy = new Proxy(owner, {
		get(target, property, receiver) {
			events.push("get");
			return Reflect.get(target, property, receiver);
		},
	});
	const effectfulKey = {
		[Symbol.toPrimitive]() {
			events.push("key");
			return key;
		},
	};
	check(Object.is(proxy[effectfulKey], expected), "proxy data read retains its target");
	check(events.join(",") === "key,get", "key conversion precedes proxy lookup");
	events.length = 0;
	const throwing = new Proxy(owner, {
		get() {
			events.push("throw");
			throw sentinel;
		},
	});
	try {
		throwing[effectfulKey];
		throw new Error("unused proxy read must throw");
	} catch (error) {
		check(error === sentinel, "data read retains proxy exceptions");
	}
	check(events.join(",") === "key,throw", "unused read preserves conversion and trap");
	events.length = 0;
	try {
		proxy[
			{
				[Symbol.toPrimitive]() {
					events.push("key-throw");
					throw sentinel;
				},
			}
		];
		throw new Error("key conversion must throw");
	} catch (error) {
		check(error === sentinel, "data read retains earlier key exceptions");
	}
	check(events.join(",") === "key-throw", "earlier key exception suppresses the read");
}

for (const [read, owner, key] of functionReads) {
	const first = read();
	check(typeof first === "function", "function value");
	check(first === owner[key], "canonical object identity");
	const descriptor = Object.getOwnPropertyDescriptor(owner, key);
	if (descriptor.configurable) {
		const replacement = function replacement() {};
		try {
			Object.defineProperty(owner, key, { ...descriptor, value: replacement });
			check(read() === replacement, "mutable lookup");
		} finally {
			Object.defineProperty(owner, key, descriptor);
		}
	}
	check(first === read(), "restored identity");
}
check(String.prototype.trimLeft === String.prototype.trimStart, "trimStart alias");
check(String.prototype.trimRight === String.prototype.trimEnd, "trimEnd alias");
check(Number.parseInt === parseInt, "parseInt alias");
check(Number.parseFloat === parseFloat, "parseFloat alias");
check(String.prototype.toString !== String.prototype.valueOf, "String method identities");
check(
	Symbol.prototype.valueOf !== Symbol.prototype[Symbol.toPrimitive],
	"Symbol method identities",
);

const rejectedConstructors = [
	(effect) => new BigInt([effect()], effect()),
	(effect) => new BigInt.asIntN([effect()], effect()),
	(effect) => new BigInt.asUintN([effect()], effect()),
	(effect) => new BigInt.prototype.toString([effect()], effect()),
	(effect) => new BigInt.prototype.valueOf([effect()], effect()),
	(effect) => new Boolean.prototype.toString([effect()], effect()),
	(effect) => new Boolean.prototype.valueOf([effect()], effect()),
	(effect) => new Math.abs([effect()], effect()),
	(effect) => new Math.acos([effect()], effect()),
	(effect) => new Math.acosh([effect()], effect()),
	(effect) => new Math.asin([effect()], effect()),
	(effect) => new Math.asinh([effect()], effect()),
	(effect) => new Math.atan([effect()], effect()),
	(effect) => new Math.atan2([effect()], effect()),
	(effect) => new Math.atanh([effect()], effect()),
	(effect) => new Math.cbrt([effect()], effect()),
	(effect) => new Math.ceil([effect()], effect()),
	(effect) => new Math.clz32([effect()], effect()),
	(effect) => new Math.cos([effect()], effect()),
	(effect) => new Math.cosh([effect()], effect()),
	(effect) => new Math.exp([effect()], effect()),
	(effect) => new Math.expm1([effect()], effect()),
	(effect) => new Math.f16round([effect()], effect()),
	(effect) => new Math.floor([effect()], effect()),
	(effect) => new Math.fround([effect()], effect()),
	(effect) => new Math.hypot([effect()], effect()),
	(effect) => new Math.imul([effect()], effect()),
	(effect) => new Math.log([effect()], effect()),
	(effect) => new Math.log10([effect()], effect()),
	(effect) => new Math.log1p([effect()], effect()),
	(effect) => new Math.log2([effect()], effect()),
	(effect) => new Math.max([effect()], effect()),
	(effect) => new Math.min([effect()], effect()),
	(effect) => new Math.pow([effect()], effect()),
	(effect) => new Math.random([effect()], effect()),
	(effect) => new Math.round([effect()], effect()),
	(effect) => new Math.sign([effect()], effect()),
	(effect) => new Math.sin([effect()], effect()),
	(effect) => new Math.sinh([effect()], effect()),
	(effect) => new Math.sqrt([effect()], effect()),
	(effect) => new Math.sumPrecise([effect()], effect()),
	(effect) => new Math.tan([effect()], effect()),
	(effect) => new Math.tanh([effect()], effect()),
	(effect) => new Math.trunc([effect()], effect()),
	(effect) => new Number.isFinite([effect()], effect()),
	(effect) => new Number.isInteger([effect()], effect()),
	(effect) => new Number.isNaN([effect()], effect()),
	(effect) => new Number.isSafeInteger([effect()], effect()),
	(effect) => new Number.prototype.toExponential([effect()], effect()),
	(effect) => new Number.prototype.toFixed([effect()], effect()),
	(effect) => new Number.prototype.toPrecision([effect()], effect()),
	(effect) => new Number.prototype.toString([effect()], effect()),
	(effect) => new Number.prototype.valueOf([effect()], effect()),
	(effect) => new String.fromCharCode([effect()], effect()),
	(effect) => new String.fromCodePoint([effect()], effect()),
	(effect) => new String.prototype.anchor([effect()], effect()),
	(effect) => new String.prototype.at([effect()], effect()),
	(effect) => new String.prototype.big([effect()], effect()),
	(effect) => new String.prototype.blink([effect()], effect()),
	(effect) => new String.prototype.bold([effect()], effect()),
	(effect) => new String.prototype.charAt([effect()], effect()),
	(effect) => new String.prototype.charCodeAt([effect()], effect()),
	(effect) => new String.prototype.codePointAt([effect()], effect()),
	(effect) => new String.prototype.concat([effect()], effect()),
	(effect) => new String.prototype.endsWith([effect()], effect()),
	(effect) => new String.prototype.fixed([effect()], effect()),
	(effect) => new String.prototype.fontcolor([effect()], effect()),
	(effect) => new String.prototype.fontsize([effect()], effect()),
	(effect) => new String.prototype.includes([effect()], effect()),
	(effect) => new String.prototype.indexOf([effect()], effect()),
	(effect) => new String.prototype.isWellFormed([effect()], effect()),
	(effect) => new String.prototype.italics([effect()], effect()),
	(effect) => new String.prototype.lastIndexOf([effect()], effect()),
	(effect) => new String.prototype.link([effect()], effect()),
	(effect) => new String.prototype.localeCompare([effect()], effect()),
	(effect) => new String.prototype.normalize([effect()], effect()),
	(effect) => new String.prototype.padEnd([effect()], effect()),
	(effect) => new String.prototype.padStart([effect()], effect()),
	(effect) => new String.prototype.repeat([effect()], effect()),
	(effect) => new String.prototype.replace([effect()], effect()),
	(effect) => new String.prototype.replaceAll([effect()], effect()),
	(effect) => new String.prototype.slice([effect()], effect()),
	(effect) => new String.prototype.small([effect()], effect()),
	(effect) => new String.prototype.split([effect()], effect()),
	(effect) => new String.prototype.startsWith([effect()], effect()),
	(effect) => new String.prototype.strike([effect()], effect()),
	(effect) => new String.prototype.sub([effect()], effect()),
	(effect) => new String.prototype.substr([effect()], effect()),
	(effect) => new String.prototype.substring([effect()], effect()),
	(effect) => new String.prototype.sup([effect()], effect()),
	(effect) => new String.prototype.toLocaleLowerCase([effect()], effect()),
	(effect) => new String.prototype.toLocaleUpperCase([effect()], effect()),
	(effect) => new String.prototype.toLowerCase([effect()], effect()),
	(effect) => new String.prototype.toString([effect()], effect()),
	(effect) => new String.prototype.toUpperCase([effect()], effect()),
	(effect) => new String.prototype.toWellFormed([effect()], effect()),
	(effect) => new String.prototype.trim([effect()], effect()),
	(effect) => new String.prototype.trimEnd([effect()], effect()),
	(effect) => new String.prototype.trimStart([effect()], effect()),
	(effect) => new String.prototype.valueOf([effect()], effect()),
	(effect) => new String.raw([effect()], effect()),
	(effect) => new Symbol([effect()], effect()),
	(effect) => new Symbol.for([effect()], effect()),
	(effect) => new Symbol.keyFor([effect()], effect()),
	(effect) =>
		new (Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get)(
			[effect()],
			effect(),
		),
	(effect) => new Symbol.prototype.toString([effect()], effect()),
	(effect) => new Symbol.prototype.valueOf([effect()], effect()),
	(effect) => new Symbol.prototype[Symbol.toPrimitive]([effect()], effect()),
	(effect) => new decodeURI([effect()], effect()),
	(effect) => new decodeURIComponent([effect()], effect()),
	(effect) => new encodeURI([effect()], effect()),
	(effect) => new encodeURIComponent([effect()], effect()),
	(effect) => new globalThis.escape([effect()], effect()),
	(effect) => new globalThis.unescape([effect()], effect()),
	(effect) => new isFinite([effect()], effect()),
	(effect) => new isNaN([effect()], effect()),
	(effect) => new parseFloat([effect()], effect()),
	(effect) => new parseInt([effect()], effect()),
];

for (const construct of rejectedConstructors) {
	let effects = 0;
	const attempt = () => {
		try {
			construct(() => ++effects);
		} catch (error) {
			return error;
		}
		throw new Error("construction must fail");
	};
	const first = attempt();
	const second = attempt();
	check(
		first instanceof TypeError && second instanceof TypeError,
		"construction error kind",
	);
	check(first !== second, "fresh thrown errors");
	check(effects === 4, "argument evaluation before rejection");
	try {
		construct(() => {
			effects++;
			throw new RangeError("argument");
		});
		throw new Error("argument must fail");
	} catch (error) {
		check(error instanceof RangeError, "argument error precedes rejection");
	}
	check(effects === 5, "no replay after argument failure");
}
function* suspendedConstructor(construct, effect) {
	yield effect();
	construct(effect);
	return 17;
}
function discardConstructorResult(construct, effect) {
	construct(effect);
	return 17;
}
globalThis.suspendedConstructor = suspendedConstructor;
globalThis.discardConstructorResult = discardConstructorResult;
for (const construct of rejectedConstructors) {
	const events = [];
	const argument = {
		[Symbol.toPrimitive]() {
			events.push("coerce");
			return "field";
		},
	};
	const escaped = [];
	const effect = () => {
		events.push("argument");
		escaped.push(argument);
		return argument;
	};
	const iterator = globalThis.suspendedConstructor(construct, effect);
	const first = iterator.next();
	check(first.value === argument && !first.done, "construction stays beyond the yield");
	if (typeof globalThis.gc === "function") globalThis.gc();
	let previous;
	try {
		iterator.next();
		throw new Error("resumed construction must reject");
	} catch (error) {
		check(error instanceof TypeError, "resumed construction error");
		previous = error;
	}
	check(iterator.next().done, "abrupt construction closes the generator");
	check(
		events.join(",") === "argument,argument,argument",
		"rejected construction does not coerce its arguments",
	);
	check(
		escaped.length === 3 && escaped.every((value) => value === argument),
		"argument escape retains identity",
	);
	events.length = 0;
	try {
		globalThis.discardConstructorResult(construct, effect);
		throw new Error("unused construction must reject");
	} catch (error) {
		check(
			error instanceof TypeError && error !== previous,
			"unused construction has its own error identity",
		);
	}
	check(
		events.join(",") === "argument,argument",
		"unused construction retains argument producers",
	);
}
globalThis.rejectedArrayLikeConstructors = [
	(list, target, effect) =>
		Reflect.construct(BigInt.asIntN, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(BigInt.asUintN, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(BigInt.prototype.toString, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(BigInt.prototype.valueOf, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Boolean.prototype.toString, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Boolean.prototype.valueOf, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.abs, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.acos, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.acosh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.asin, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.asinh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.atan, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.atan2, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.atanh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.cbrt, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.ceil, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.clz32, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.cos, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.cosh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.exp, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.expm1, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Math.f16round, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.floor, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.fround, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.hypot, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.imul, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.log, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.log10, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.log1p, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.log2, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.max, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.min, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.pow, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.random, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.round, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.sign, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.sin, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.sinh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.sqrt, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Math.sumPrecise, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.tan, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.tanh, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Math.trunc, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.isFinite, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.isInteger, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Number.isNaN, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.isSafeInteger, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.prototype.toExponential, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.prototype.toFixed, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.prototype.toPrecision, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.prototype.toString, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Number.prototype.valueOf, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.fromCharCode, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.fromCodePoint, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.anchor, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.at, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.big, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.blink, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.bold, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.charAt, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.charCodeAt, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.codePointAt, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.concat, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.endsWith, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.fixed, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.fontcolor, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.fontsize, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.includes, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.indexOf, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.isWellFormed, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.italics, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.lastIndexOf, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.link, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.localeCompare, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.normalize, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.padEnd, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.padStart, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.repeat, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.replace, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.replaceAll, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.slice, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.small, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.split, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.startsWith, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.strike, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.sub, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.substr, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.substring, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.sup, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toLocaleLowerCase, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toLocaleUpperCase, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toLowerCase, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toString, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toUpperCase, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.toWellFormed, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.trim, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.trimEnd, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.trimStart, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(String.prototype.valueOf, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(String.raw, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(Symbol.for, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Symbol.keyFor, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Symbol.prototype.toString, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Symbol.prototype.valueOf, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(Symbol.prototype[Symbol.toPrimitive], effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(decodeURI, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(decodeURIComponent, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(encodeURI, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(encodeURIComponent, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(globalThis.escape, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(globalThis.unescape, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(isFinite, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(isNaN, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(parseFloat, effect(list), effect(target)),
	(list, target, effect) => Reflect.construct(parseInt, effect(list), effect(target)),
	(list, target, effect) =>
		Reflect.construct(
			Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get,
			effect(list),
			effect(target),
		),
];

const ordering = [];
const unreadList = new Proxy(
	{},
	{
		get() {
			ordering.push("list read");
			throw new SyntaxError("list read");
		},
	},
);
const unreadTarget = new Proxy(function Target() {}, {
	get() {
		ordering.push("target read");
		throw new SyntaxError("target read");
	},
});
for (const reject of globalThis.rejectedArrayLikeConstructors) {
	let previous;
	for (const list of [undefined, null, 0, unreadList]) {
		for (const target of [undefined, null, () => {}, unreadTarget]) {
			ordering.length = 0;
			let calls = 0;
			try {
				reject(list, target, (value) => {
					ordering.push(++calls);
					return value;
				});
				throw new Error("Reflect construction must reject");
			} catch (error) {
				check(error instanceof TypeError, "Reflect rejection kind");
				check(error !== previous, "Reflect errors are fresh");
				previous = error;
			}
			check(ordering.join() === "1,2", "only argument expressions precede rejection");
		}
	}
	for (const throwAt of [1, 2]) {
		let calls = 0;
		try {
			reject(unreadList, unreadTarget, (value) => {
				if (++calls === throwAt) throw new RangeError("argument expression");
				return value;
			});
			throw new Error("argument must reject");
		} catch (error) {
			check(error instanceof RangeError, "argument expression rejects first");
		}
		check(calls === throwAt, "later arguments are not evaluated after a throw");
	}
}
function spreadReject(input) {
	return new Math.abs(...input);
}
function reflectedSpreadReject(input) {
	return Reflect.construct(Math.abs, [...input]);
}
globalThis.spreadReject = spreadReject;
globalThis.reflectedSpreadReject = reflectedSpreadReject;
for (const reject of [globalThis.spreadReject, globalThis.reflectedSpreadReject]) {
	let visits = 0;
	const iterable = {
		*[Symbol.iterator]() {
			visits++;
			yield 1;
			visits++;
			yield 2;
			visits++;
		},
	};
	try {
		reject(iterable);
		throw new Error("spread must reject");
	} catch (error) {
		check(error instanceof TypeError, "spread construction rejection");
	}
	check(visits === 3, "spread iterator finishes before constructor rejection");
	const broken = {
		get [Symbol.iterator]() {
			throw new SyntaxError("iterator");
		},
	};
	try {
		reject(broken);
		throw new Error("iterator must reject");
	} catch (error) {
		check(error instanceof SyntaxError, "iterator fails before constructor rejection");
	}
}
function reflectBigInt(list, target) {
	return Reflect.construct(BigInt, list, target);
}
function reflectSymbol(list, target) {
	return Reflect.construct(Symbol, list, target);
}
globalThis.reflectBigInt = reflectBigInt;
globalThis.reflectSymbol = reflectSymbol;
for (const [construct, target] of [
	[globalThis.reflectBigInt, BigInt],
	[globalThis.reflectSymbol, Symbol],
]) {
	let reads = 0;
	const list = {
		get length() {
			reads++;
			return 1;
		},
		get 0() {
			reads++;
			return {
				[Symbol.toPrimitive]() {
					throw new Error("body converted input");
				},
			};
		},
	};
	try {
		construct(list, target);
		throw new Error("constructor body must reject");
	} catch (error) {
		check(error instanceof TypeError, "constructor body rejection");
	}
	check(reads === 2, "constructable builtin reads its argument list before entry");
	reads = 0;
	try {
		construct(list, null);
		throw new Error("newTarget must reject");
	} catch (error) {
		check(error instanceof TypeError, "newTarget rejection");
	}
	check(reads === 0, "invalid newTarget precedes list access");
}
function* suspendedRejection(list) {
	yield 17;
	return Reflect.construct(Math.abs, list);
}
globalThis.suspendedRejection = suspendedRejection;
const suspended = globalThis.suspendedRejection(unreadList);
check(suspended.next().value === 17, "rejection stays after suspension");
try {
	suspended.next();
	throw new Error("resumed operation must reject");
} catch (error) {
	check(error instanceof TypeError, "resumed rejection");
}
check(suspended.next().done, "generator closes after rejection");
function computedListRejection(key, value, target) {
	return Reflect.construct(
		Math.abs,
		{
			get length() {
				throw new Error("list read");
			},
			[key]: value(),
		},
		target(),
	);
}
function computedObject(key, value) {
	return { [key]: value() };
}
function computedNamedProperties(key) {
	return {
		[key]: function () {},
		get [key]() {
			return 17;
		},
		set [key](value) {},
	};
}
function computedAnonymousFunction(key) {
	return { [key]: function () {} };
}
globalThis.computedListRejection = computedListRejection;
globalThis.computedObject = computedObject;
globalThis.computedNamedProperties = computedNamedProperties;
globalThis.computedAnonymousFunction = computedAnonymousFunction;
for (const discard of [false, true]) {
	const events = [];
	const key = {
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			return "field";
		},
	};
	const value = () => {
		events.push("value");
		return 19;
	};
	const target = () => {
		events.push("target");
		return Number;
	};
	if (discard) {
		try {
			globalThis.computedListRejection(key, value, target);
			throw new Error("computed list must reject");
		} catch (error) {
			check(error instanceof TypeError, "computed list rejection");
		}
	} else {
		check(globalThis.computedObject(key, value).field === 19, "computed object value");
	}
	check(
		events.join(",") === (discard ? "string,value,target" : "string,value"),
		"key conversion precedes value and later arguments",
	);
	events.length = 0;
	const throwingKey = {
		[Symbol.toPrimitive]() {
			events.push("key");
			throw new RangeError("key");
		},
	};
	try {
		if (discard) globalThis.computedListRejection(throwingKey, value, target);
		else globalThis.computedObject(throwingKey, value);
		throw new Error("key must reject");
	} catch (error) {
		check(error instanceof RangeError, "key conversion error is preserved");
	}
	check(events.join(",") === "key", "throwing key prevents value and later arguments");
}
const propertySymbol = Symbol("field");
let keyConversions = 0;
const namedKey = {
	[Symbol.toPrimitive]() {
		keyConversions++;
		return propertySymbol;
	},
};
const namedObject = globalThis.computedNamedProperties(namedKey);
const namedDescriptor = Object.getOwnPropertyDescriptor(namedObject, propertySymbol);
check(keyConversions === 3, "each computed name converts exactly once");
check(typeof namedDescriptor.get === "function", "symbol getter retained");
check(typeof namedDescriptor.set === "function", "symbol setter retained");
check(namedObject[propertySymbol] === 17, "duplicate getter and setter merge");
const anonymous = globalThis.computedAnonymousFunction(namedKey)[propertySymbol];
check(keyConversions === 4, "anonymous function naming reuses the converted key");
check(anonymous.name === "[field]", "computed anonymous function name");
let escapedGetter;
function retainHomeObject(escape) {
	const object = {
		__proto__: { value: 23 },
		get value() {
			return super.value;
		},
	};
	escape(Object.getOwnPropertyDescriptor(object, "value").get);
	return Reflect.construct(Math.abs, object);
}
globalThis.retainHomeObject = retainHomeObject;
try {
	globalThis.retainHomeObject((getter) => {
		escapedGetter = getter;
	});
	throw new Error("home object list must reject");
} catch (error) {
	check(error instanceof TypeError, "home object rejection");
}
check(escapedGetter.call(null) === 23, "escaped getter retains its home object");
const reflectedDataReads = [
	[(x) => Reflect.get(BigInt, "asUintN", x(), x()), () => BigInt.asUintN],
	[(x) => Reflect.get(BigInt, "asIntN", x(), x()), () => BigInt.asIntN],
	[
		(x) => Reflect.get(BigInt.prototype, "toString", x(), x()),
		() => BigInt.prototype.toString,
	],
	[
		(x) => Reflect.get(BigInt.prototype, "valueOf", x(), x()),
		() => BigInt.prototype.valueOf,
	],
	[
		(x) => Reflect.get(Boolean.prototype, "toString", x(), x()),
		() => Boolean.prototype.toString,
	],
	[
		(x) => Reflect.get(Boolean.prototype, "valueOf", x(), x()),
		() => Boolean.prototype.valueOf,
	],
	[(x) => Reflect.get(Math, "abs", x(), x()), () => Math.abs],
	[(x) => Reflect.get(Math, "floor", x(), x()), () => Math.floor],
	[(x) => Reflect.get(Math, "ceil", x(), x()), () => Math.ceil],
	[(x) => Reflect.get(Math, "round", x(), x()), () => Math.round],
	[(x) => Reflect.get(Math, "trunc", x(), x()), () => Math.trunc],
	[(x) => Reflect.get(Math, "sqrt", x(), x()), () => Math.sqrt],
	[(x) => Reflect.get(Math, "cbrt", x(), x()), () => Math.cbrt],
	[(x) => Reflect.get(Math, "sign", x(), x()), () => Math.sign],
	[(x) => Reflect.get(Math, "log", x(), x()), () => Math.log],
	[(x) => Reflect.get(Math, "log2", x(), x()), () => Math.log2],
	[(x) => Reflect.get(Math, "log10", x(), x()), () => Math.log10],
	[(x) => Reflect.get(Math, "exp", x(), x()), () => Math.exp],
	[(x) => Reflect.get(Math, "sin", x(), x()), () => Math.sin],
	[(x) => Reflect.get(Math, "cos", x(), x()), () => Math.cos],
	[(x) => Reflect.get(Math, "tan", x(), x()), () => Math.tan],
	[(x) => Reflect.get(Math, "asin", x(), x()), () => Math.asin],
	[(x) => Reflect.get(Math, "acos", x(), x()), () => Math.acos],
	[(x) => Reflect.get(Math, "atan", x(), x()), () => Math.atan],
	[(x) => Reflect.get(Math, "sinh", x(), x()), () => Math.sinh],
	[(x) => Reflect.get(Math, "cosh", x(), x()), () => Math.cosh],
	[(x) => Reflect.get(Math, "tanh", x(), x()), () => Math.tanh],
	[(x) => Reflect.get(Math, "asinh", x(), x()), () => Math.asinh],
	[(x) => Reflect.get(Math, "acosh", x(), x()), () => Math.acosh],
	[(x) => Reflect.get(Math, "atanh", x(), x()), () => Math.atanh],
	[(x) => Reflect.get(Math, "log1p", x(), x()), () => Math.log1p],
	[(x) => Reflect.get(Math, "expm1", x(), x()), () => Math.expm1],
	[(x) => Reflect.get(Math, "fround", x(), x()), () => Math.fround],
	[(x) => Reflect.get(Math, "f16round", x(), x()), () => Math.f16round],
	[(x) => Reflect.get(Math, "clz32", x(), x()), () => Math.clz32],
	[(x) => Reflect.get(Math, "imul", x(), x()), () => Math.imul],
	[(x) => Reflect.get(Math, "atan2", x(), x()), () => Math.atan2],
	[(x) => Reflect.get(Math, "pow", x(), x()), () => Math.pow],
	[(x) => Reflect.get(Math, "hypot", x(), x()), () => Math.hypot],
	[(x) => Reflect.get(Math, "min", x(), x()), () => Math.min],
	[(x) => Reflect.get(Math, "max", x(), x()), () => Math.max],
	[(x) => Reflect.get(Math, "sumPrecise", x(), x()), () => Math.sumPrecise],
	[(x) => Reflect.get(Math, "random", x(), x()), () => Math.random],
	[(x) => Reflect.get(Number, "isNaN", x(), x()), () => Number.isNaN],
	[(x) => Reflect.get(Number, "isFinite", x(), x()), () => Number.isFinite],
	[(x) => Reflect.get(Number, "isInteger", x(), x()), () => Number.isInteger],
	[(x) => Reflect.get(Number, "isSafeInteger", x(), x()), () => Number.isSafeInteger],
	[(x) => Reflect.get(Number, "parseInt", x(), x()), () => Number.parseInt],
	[(x) => Reflect.get(Number, "parseFloat", x(), x()), () => Number.parseFloat],
	[
		(x) => Reflect.get(Number.prototype, "toString", x(), x()),
		() => Number.prototype.toString,
	],
	[
		(x) => Reflect.get(Number.prototype, "toFixed", x(), x()),
		() => Number.prototype.toFixed,
	],
	[
		(x) => Reflect.get(Number.prototype, "toExponential", x(), x()),
		() => Number.prototype.toExponential,
	],
	[
		(x) => Reflect.get(Number.prototype, "toPrecision", x(), x()),
		() => Number.prototype.toPrecision,
	],
	[
		(x) => Reflect.get(Number.prototype, "valueOf", x(), x()),
		() => Number.prototype.valueOf,
	],
	[(x) => Reflect.get(String, "fromCharCode", x(), x()), () => String.fromCharCode],
	[(x) => Reflect.get(String, "fromCodePoint", x(), x()), () => String.fromCodePoint],
	[(x) => Reflect.get(String, "raw", x(), x()), () => String.raw],
	[
		(x) => Reflect.get(String.prototype, "charAt", x(), x()),
		() => String.prototype.charAt,
	],
	[
		(x) => Reflect.get(String.prototype, "charCodeAt", x(), x()),
		() => String.prototype.charCodeAt,
	],
	[
		(x) => Reflect.get(String.prototype, "codePointAt", x(), x()),
		() => String.prototype.codePointAt,
	],
	[(x) => Reflect.get(String.prototype, "at", x(), x()), () => String.prototype.at],
	[
		(x) => Reflect.get(String.prototype, "indexOf", x(), x()),
		() => String.prototype.indexOf,
	],
	[
		(x) => Reflect.get(String.prototype, "lastIndexOf", x(), x()),
		() => String.prototype.lastIndexOf,
	],
	[
		(x) => Reflect.get(String.prototype, "includes", x(), x()),
		() => String.prototype.includes,
	],
	[
		(x) => Reflect.get(String.prototype, "startsWith", x(), x()),
		() => String.prototype.startsWith,
	],
	[
		(x) => Reflect.get(String.prototype, "endsWith", x(), x()),
		() => String.prototype.endsWith,
	],
	[(x) => Reflect.get(String.prototype, "slice", x(), x()), () => String.prototype.slice],
	[
		(x) => Reflect.get(String.prototype, "substring", x(), x()),
		() => String.prototype.substring,
	],
	[
		(x) => Reflect.get(String.prototype, "substr", x(), x()),
		() => String.prototype.substr,
	],
	[
		(x) => Reflect.get(String.prototype, "anchor", x(), x()),
		() => String.prototype.anchor,
	],
	[(x) => Reflect.get(String.prototype, "big", x(), x()), () => String.prototype.big],
	[(x) => Reflect.get(String.prototype, "blink", x(), x()), () => String.prototype.blink],
	[(x) => Reflect.get(String.prototype, "bold", x(), x()), () => String.prototype.bold],
	[(x) => Reflect.get(String.prototype, "fixed", x(), x()), () => String.prototype.fixed],
	[
		(x) => Reflect.get(String.prototype, "fontcolor", x(), x()),
		() => String.prototype.fontcolor,
	],
	[
		(x) => Reflect.get(String.prototype, "fontsize", x(), x()),
		() => String.prototype.fontsize,
	],
	[
		(x) => Reflect.get(String.prototype, "italics", x(), x()),
		() => String.prototype.italics,
	],
	[(x) => Reflect.get(String.prototype, "link", x(), x()), () => String.prototype.link],
	[(x) => Reflect.get(String.prototype, "small", x(), x()), () => String.prototype.small],
	[
		(x) => Reflect.get(String.prototype, "strike", x(), x()),
		() => String.prototype.strike,
	],
	[(x) => Reflect.get(String.prototype, "sub", x(), x()), () => String.prototype.sub],
	[(x) => Reflect.get(String.prototype, "sup", x(), x()), () => String.prototype.sup],
	[
		(x) => Reflect.get(String.prototype, "concat", x(), x()),
		() => String.prototype.concat,
	],
	[
		(x) => Reflect.get(String.prototype, "localeCompare", x(), x()),
		() => String.prototype.localeCompare,
	],
	[
		(x) => Reflect.get(String.prototype, "normalize", x(), x()),
		() => String.prototype.normalize,
	],
	[
		(x) => Reflect.get(String.prototype, "repeat", x(), x()),
		() => String.prototype.repeat,
	],
	[(x) => Reflect.get(String.prototype, "trim", x(), x()), () => String.prototype.trim],
	[
		(x) => Reflect.get(String.prototype, "trimStart", x(), x()),
		() => String.prototype.trimStart,
	],
	[
		(x) => Reflect.get(String.prototype, "trimEnd", x(), x()),
		() => String.prototype.trimEnd,
	],
	[
		(x) => Reflect.get(String.prototype, "trimLeft", x(), x()),
		() => String.prototype.trimLeft,
	],
	[
		(x) => Reflect.get(String.prototype, "trimRight", x(), x()),
		() => String.prototype.trimRight,
	],
	[
		(x) => Reflect.get(String.prototype, "toUpperCase", x(), x()),
		() => String.prototype.toUpperCase,
	],
	[
		(x) => Reflect.get(String.prototype, "toLowerCase", x(), x()),
		() => String.prototype.toLowerCase,
	],
	[
		(x) => Reflect.get(String.prototype, "toLocaleUpperCase", x(), x()),
		() => String.prototype.toLocaleUpperCase,
	],
	[
		(x) => Reflect.get(String.prototype, "toLocaleLowerCase", x(), x()),
		() => String.prototype.toLocaleLowerCase,
	],
	[
		(x) => Reflect.get(String.prototype, "isWellFormed", x(), x()),
		() => String.prototype.isWellFormed,
	],
	[
		(x) => Reflect.get(String.prototype, "toWellFormed", x(), x()),
		() => String.prototype.toWellFormed,
	],
	[(x) => Reflect.get(String.prototype, "split", x(), x()), () => String.prototype.split],
	[
		(x) => Reflect.get(String.prototype, "replace", x(), x()),
		() => String.prototype.replace,
	],
	[
		(x) => Reflect.get(String.prototype, "replaceAll", x(), x()),
		() => String.prototype.replaceAll,
	],
	[
		(x) => Reflect.get(String.prototype, "padStart", x(), x()),
		() => String.prototype.padStart,
	],
	[
		(x) => Reflect.get(String.prototype, "padEnd", x(), x()),
		() => String.prototype.padEnd,
	],
	[
		(x) => Reflect.get(String.prototype, "toString", x(), x()),
		() => String.prototype.toString,
	],
	[
		(x) => Reflect.get(String.prototype, "valueOf", x(), x()),
		() => String.prototype.valueOf,
	],
	[(x) => Reflect.get(Symbol, "for", x(), x()), () => Symbol.for],
	[(x) => Reflect.get(Symbol, "keyFor", x(), x()), () => Symbol.keyFor],
	[
		(x) => Reflect.get(Symbol.prototype, "toString", x(), x()),
		() => Symbol.prototype.toString,
	],
	[
		(x) => Reflect.get(Symbol.prototype, "valueOf", x(), x()),
		() => Symbol.prototype.valueOf,
	],
	[
		(x) => Reflect.get(Symbol.prototype, Symbol.toPrimitive, x(), x()),
		() => Symbol.prototype[Symbol.toPrimitive],
	],
	[(x) => Reflect.get(globalThis, "parseInt", x(), x()), () => globalThis.parseInt],
	[(x) => Reflect.get(globalThis, "parseFloat", x(), x()), () => globalThis.parseFloat],
	[(x) => Reflect.get(globalThis, "isNaN", x(), x()), () => globalThis.isNaN],
	[(x) => Reflect.get(globalThis, "isFinite", x(), x()), () => globalThis.isFinite],
	[(x) => Reflect.get(globalThis, "decodeURI", x(), x()), () => globalThis.decodeURI],
	[
		(x) => Reflect.get(globalThis, "decodeURIComponent", x(), x()),
		() => globalThis.decodeURIComponent,
	],
	[(x) => Reflect.get(globalThis, "encodeURI", x(), x()), () => globalThis.encodeURI],
	[
		(x) => Reflect.get(globalThis, "encodeURIComponent", x(), x()),
		() => globalThis.encodeURIComponent,
	],
	[(x) => Reflect.get(globalThis, "escape", x(), x()), () => globalThis.escape],
	[(x) => Reflect.get(globalThis, "unescape", x(), x()), () => globalThis.unescape],
	[(x) => Reflect.get(Math, "PI", x(), x()), () => Math.PI],
	[(x) => Reflect.get(Math, "E", x(), x()), () => Math.E],
	[(x) => Reflect.get(Math, "LN2", x(), x()), () => Math.LN2],
	[(x) => Reflect.get(Math, "LN10", x(), x()), () => Math.LN10],
	[(x) => Reflect.get(Math, "LOG2E", x(), x()), () => Math.LOG2E],
	[(x) => Reflect.get(Math, "LOG10E", x(), x()), () => Math.LOG10E],
	[(x) => Reflect.get(Math, "SQRT2", x(), x()), () => Math.SQRT2],
	[(x) => Reflect.get(Math, "SQRT1_2", x(), x()), () => Math.SQRT1_2],
	[
		(x) => Reflect.get(Number, "MAX_SAFE_INTEGER", x(), x()),
		() => Number.MAX_SAFE_INTEGER,
	],
	[
		(x) => Reflect.get(Number, "MIN_SAFE_INTEGER", x(), x()),
		() => Number.MIN_SAFE_INTEGER,
	],
	[(x) => Reflect.get(Number, "EPSILON", x(), x()), () => Number.EPSILON],
	[(x) => Reflect.get(Number, "MAX_VALUE", x(), x()), () => Number.MAX_VALUE],
	[(x) => Reflect.get(Number, "MIN_VALUE", x(), x()), () => Number.MIN_VALUE],
	[
		(x) => Reflect.get(Number, "POSITIVE_INFINITY", x(), x()),
		() => Number.POSITIVE_INFINITY,
	],
	[
		(x) => Reflect.get(Number, "NEGATIVE_INFINITY", x(), x()),
		() => Number.NEGATIVE_INFINITY,
	],
	[(x) => Reflect.get(Number, "NaN", x(), x()), () => Number.NaN],
	[(x) => Reflect.get(Symbol, "iterator", x(), x()), () => Symbol.iterator],
	[(x) => Reflect.get(Symbol, "asyncIterator", x(), x()), () => Symbol.asyncIterator],
	[(x) => Reflect.get(Symbol, "toStringTag", x(), x()), () => Symbol.toStringTag],
	[(x) => Reflect.get(Symbol, "hasInstance", x(), x()), () => Symbol.hasInstance],
	[(x) => Reflect.get(Symbol, "toPrimitive", x(), x()), () => Symbol.toPrimitive],
	[(x) => Reflect.get(Symbol, "species", x(), x()), () => Symbol.species],
	[
		(x) => Reflect.get(Symbol, "isConcatSpreadable", x(), x()),
		() => Symbol.isConcatSpreadable,
	],
	[(x) => Reflect.get(Symbol, "match", x(), x()), () => Symbol.match],
	[(x) => Reflect.get(Symbol, "matchAll", x(), x()), () => Symbol.matchAll],
	[(x) => Reflect.get(Symbol, "replace", x(), x()), () => Symbol.replace],
	[(x) => Reflect.get(Symbol, "search", x(), x()), () => Symbol.search],
	[(x) => Reflect.get(Symbol, "split", x(), x()), () => Symbol.split],
	[(x) => Reflect.get(Symbol, "unscopables", x(), x()), () => Symbol.unscopables],
	[(x) => Reflect.get(Symbol, "dispose", x(), x()), () => Symbol.dispose],
	[(x) => Reflect.get(Symbol, "asyncDispose", x(), x()), () => Symbol.asyncDispose],
];
for (const [read, direct] of reflectedDataReads) {
	const receiver = new Proxy(
		{},
		{
			get() {
				throw new Error("data receiver must not be read");
			},
		},
	);
	let calls = 0;
	const effect = () => {
		calls++;
		return receiver;
	};
	check(
		Object.is(read(effect), direct()),
		"Reflect.get preserves installed data identity",
	);
	check(calls === 2, "receiver and extra arguments run once");
	const sentinel = {};
	try {
		read(() => {
			throw sentinel;
		});
		throw new Error("receiver must throw");
	} catch (error) {
		check(error === sentinel, "receiver expression throw retained");
	}
}
function reflectedDescription(receiver) {
	return Reflect.get(Symbol.prototype, "description", receiver);
}
function omittedDescription() {
	return Reflect.get(Symbol.prototype, "description");
}
function invalidReflectTarget(key) {
	return Reflect.get(Symbol.iterator, key);
}
globalThis.reflectedDescription = reflectedDescription;
globalThis.omittedDescription = omittedDescription;
globalThis.invalidReflectTarget = invalidReflectTarget;
for (const symbol of [Symbol.iterator, Symbol(), Symbol(""), Symbol("field")]) {
	for (const receiver of [symbol, Object(symbol)])
		check(
			globalThis.reflectedDescription(receiver) === symbol.description,
			"Reflect.get getter receiver",
		);
}
let previousReflectionError;
for (const receiver of [undefined, null, 17, {}, Symbol.prototype]) {
	try {
		globalThis.reflectedDescription(receiver);
		throw new Error("receiver must reject");
	} catch (error) {
		check(
			error instanceof TypeError && error !== previousReflectionError,
			"fresh reflected getter error",
		);
		previousReflectionError = error;
	}
}
try {
	globalThis.omittedDescription();
	throw new Error("omitted receiver must reject");
} catch (error) {
	check(error instanceof TypeError, "absent receiver defaults to target");
}
let reflectedKeyCalls = 0;
const reflectedKey = {
	[Symbol.toPrimitive]() {
		reflectedKeyCalls++;
		return "description";
	},
};
try {
	globalThis.invalidReflectTarget(reflectedKey);
	throw new Error("primitive target must reject");
} catch (error) {
	check(error instanceof TypeError, "Reflect.get requires object target");
}
check(reflectedKeyCalls === 0, "target validation precedes key coercion");
const reflectedEvents = [];
const reflectedReceiver = {};
const reflectedProxy = new Proxy(Symbol.prototype, {
	get(target, key, receiver) {
		reflectedEvents.push("get");
		check(receiver === reflectedReceiver, "proxy receiver retained");
		return 37;
	},
});
check(
	Reflect.get(
		reflectedProxy,
		{
			[Symbol.toPrimitive]() {
				reflectedEvents.push("key");
				return "description";
			},
		},
		reflectedReceiver,
	) === 37,
	"proxy getter value",
);
check(
	reflectedEvents.join(",") === "key,get",
	"Reflect.get key conversion precedes proxy trap",
);
console.log("primitive identities passed");
