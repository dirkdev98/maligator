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
console.log("primitive identities passed");
