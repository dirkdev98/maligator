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
	first.marker = effects;
	const second = attempt();
	check(
		first instanceof TypeError && second instanceof TypeError,
		"construction error kind",
	);
	check(first !== second, "fresh thrown errors");
	check(
		first.marker === 2 && !Object.hasOwn(second, "marker"),
		"error mutation belongs only to its own construction attempt",
	);
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
	const events = [];
	try {
		try {
			const result = construct(() => {
				events.push("argument");
				return 17;
			});
			events.push("consumer");
			Object.prototype.valueOf.call(result);
		} finally {
			events.push("finally");
		}
	} catch (error) {
		check(
			error instanceof TypeError && error !== first && error !== second,
			"fresh error after finally",
		);
		events.push("catch");
	}
	check(
		events.join(",") === "argument,argument,finally,catch",
		"abrupt construction skips its normal result consumer and preserves finally order",
	);
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
globalThis.invalidPrimitiveTargets = [
	(list, effect) => Reflect.construct(Boolean, effect(list), Math.abs),
	(list, effect) => Reflect.construct(Boolean, effect(list), null),
	(list, effect) => Reflect.construct(Boolean, effect(list), []),
	(list, effect) => Reflect.construct(Boolean, effect(list), {}),
	(list, effect) => Reflect.construct(Boolean, effect(list), 17),
	(list, effect) => Reflect.construct(Boolean, effect(list), Symbol.iterator),
	(list, effect) => Reflect.construct(Number, effect(list), Math.abs),
	(list, effect) => Reflect.construct(Number, effect(list), null),
	(list, effect) => Reflect.construct(Number, effect(list), []),
	(list, effect) => Reflect.construct(Number, effect(list), {}),
	(list, effect) => Reflect.construct(Number, effect(list), 17),
	(list, effect) => Reflect.construct(Number, effect(list), Symbol.iterator),
	(list, effect) => Reflect.construct(String, effect(list), Math.abs),
	(list, effect) => Reflect.construct(String, effect(list), null),
	(list, effect) => Reflect.construct(String, effect(list), []),
	(list, effect) => Reflect.construct(String, effect(list), {}),
	(list, effect) => Reflect.construct(String, effect(list), 17),
	(list, effect) => Reflect.construct(String, effect(list), Symbol.iterator),
	(list, effect) => Reflect.construct(BigInt, effect(list), Math.abs),
	(list, effect) => Reflect.construct(BigInt, effect(list), null),
	(list, effect) => Reflect.construct(BigInt, effect(list), []),
	(list, effect) => Reflect.construct(BigInt, effect(list), {}),
	(list, effect) => Reflect.construct(BigInt, effect(list), 17),
	(list, effect) => Reflect.construct(BigInt, effect(list), Symbol.iterator),
	(list, effect) => Reflect.construct(Symbol, effect(list), Math.abs),
	(list, effect) => Reflect.construct(Symbol, effect(list), null),
	(list, effect) => Reflect.construct(Symbol, effect(list), []),
	(list, effect) => Reflect.construct(Symbol, effect(list), {}),
	(list, effect) => Reflect.construct(Symbol, effect(list), 17),
	(list, effect) => Reflect.construct(Symbol, effect(list), Symbol.iterator),
];
for (const reject of globalThis.invalidPrimitiveTargets) {
	let previous;
	for (let iteration = 0; iteration < 2; iteration++) {
		let effects = 0;
		ordering.length = 0;
		try {
			reject(unreadList, (value) => {
				effects++;
				return value;
			});
			throw new Error("invalid target must reject");
		} catch (error) {
			check(
				error instanceof TypeError && error !== previous,
				"invalid target fresh error",
			);
			previous = error;
		}
		check(effects === 1 && ordering.length === 0, "invalid target precedes list reads");
	}
	const sentinel = {};
	try {
		reject(unreadList, () => {
			throw sentinel;
		});
		throw new Error("argument expression must reject");
	} catch (error) {
		check(error === sentinel, "argument expression precedes target validation");
	}
}
globalThis.abruptPrimitiveTargets = [
	(effect) => Reflect.construct(BigInt, [effect(), effect()], Boolean),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], Number),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], String),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], BigInt),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], Symbol),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], Array),
	(effect) => Reflect.construct(BigInt, [effect(), effect()], Object),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], Boolean),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], Number),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], String),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], BigInt),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], Symbol),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], Array),
	(effect) => Reflect.construct(Symbol, [effect(), effect()], Object),
];
for (const reject of globalThis.abruptPrimitiveTargets) {
	let effects = 0;
	let coercions = 0;
	const value = {
		[Symbol.toPrimitive]() {
			coercions++;
			throw new Error("conversion");
		},
	};
	try {
		reject(() => {
			effects++;
			return value;
		});
		throw new Error("primitive constructor must reject");
	} catch (error) {
		check(
			error instanceof TypeError,
			"valid target reaches primitive constructor rejection",
		);
	}
	check(
		effects === 2 && coercions === 0,
		"constructor rejection follows expressions without coercion",
	);
	const sentinel = {};
	try {
		reject(() => {
			throw sentinel;
		});
		throw new Error("argument expression must reject");
	} catch (error) {
		check(error === sentinel, "valid target preserves throwing expression");
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
function consumePrivateDescriptors(consume, count) {
	let result = 0;
	for (let i = 0; i < count; i++) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(Symbol.prototype, "description");
			result += consume(descriptor.get);
		} catch (error) {
			result--;
		}
	}
	return result;
}
globalThis.consumePrivateDescriptors = consumePrivateDescriptors;
const rootedGetter = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get;
const weakGetter = new WeakRef(rootedGetter);
const getterKeys = new WeakMap([[rootedGetter, 17]]);
let descriptorCalls = 0;
check(
	globalThis.consumePrivateDescriptors((getter) => {
		descriptorCalls++;
		if (typeof globalThis.gc === "function") globalThis.gc();
		check(weakGetter.deref() === getter, "rooted getter survives descriptor elimination");
		check(getterKeys.get(getter) === 17, "rooted getter remains a valid weak key");
		if (descriptorCalls === 2) throw new Error("descriptor consumer");
		return getter.call(Symbol("probe")).length;
	}, 3) === 9,
	"descriptor reads preserve loop exception handling",
);
check(descriptorCalls === 3, "descriptor consumer runs once per iteration");
const escapedDescriptors = [];
for (let i = 0; i < 3; i++) {
	const descriptor = Object.getOwnPropertyDescriptor(Symbol.prototype, "description");
	escapedDescriptors.push(descriptor);
	descriptor.get = i;
}
check(
	new Set(escapedDescriptors).size === 3,
	"escaping descriptors have fresh identities",
);
check(
	escapedDescriptors.every((descriptor, index) => descriptor.get === index),
	"escaping descriptors retain independent mutable state",
);
check(
	Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get === rootedGetter,
	"descriptor mutation does not change the primordial getter",
);
function branchBeforeRejection(reject, record) {
	try {
		if (reject) new Math.abs(record("argument"));
		record("normal");
		return 7;
	} finally {
		record("finally");
	}
}
function* rejectWithSuspendedFinally(record) {
	try {
		try {
			new Math.abs(record("argument"));
			yield record("unreachable");
		} finally {
			yield record("inner-finally");
		}
	} finally {
		record("outer-finally");
	}
}
globalThis.branchBeforeRejection = branchBeforeRejection;
globalThis.rejectWithSuspendedFinally = rejectWithSuspendedFinally;
for (const reject of [false, true]) {
	const events = [];
	try {
		const result = globalThis.branchBeforeRejection(reject, (event) =>
			events.push(event),
		);
		check(!reject && result === 7, "reachable branch returns normally");
	} catch (error) {
		check(reject && error instanceof TypeError, "rejecting branch throws");
	}
	check(
		events.join(",") === (reject ? "argument,finally" : "normal,finally"),
		"shared continuation and finally preserve branch reachability",
	);
}
const abruptEvents = [];
const abruptIterator = globalThis.rejectWithSuspendedFinally((event) => {
	abruptEvents.push(event);
	return event;
});
const suspendedFinally = abruptIterator.next();
check(
	!suspendedFinally.done && suspendedFinally.value === "inner-finally",
	"rejection suspends in the inner finally",
);
if (typeof globalThis.gc === "function") globalThis.gc();
try {
	abruptIterator.next();
	throw new Error("suspended rejection must throw");
} catch (error) {
	check(error instanceof TypeError, "suspended rejection retains its error");
}
check(
	abruptEvents.join(",") === "argument,inner-finally,outer-finally",
	"nested finally runs after suspended rejection without dead yields",
);
const priorError = new RangeError("argument failure");
let priorFinally = false;
try {
	globalThis.branchBeforeRejection(true, (event) => {
		if (event === "argument") throw priorError;
		if (event === "finally") priorFinally = true;
	});
	throw new Error("argument failure must throw");
} catch (error) {
	check(
		error === priorError && priorFinally,
		"argument failure precedes built-in rejection and runs finally",
	);
}
function escapingSymbolText(input, record) {
	const description = {
		[Symbol.toPrimitive](hint) {
			record(`coerce:${hint}`);
			return input;
		},
	};
	const value = Symbol(description, record("extra"));
	record(value);
	description[Symbol.toPrimitive] = () => {
		throw new Error("description coerced after creation");
	};
	return [value, value.description, value.toString(), String(value)];
}
function escapingRegisteredSymbolText(input, record) {
	const value = Symbol.for(input);
	record(value);
	return [
		value,
		value.description,
		value.toString(),
		String(value),
		Symbol.keyFor(value),
	];
}
function* suspendedEscapingSymbolText(input, record) {
	const value = Symbol({
		toString() {
			record("convert");
			return input;
		},
	});
	yield value;
	record("resume");
	return [value, value.description, value.toString(), String(value)];
}
function abruptEscapingSymbolText(error, record) {
	try {
		const value = Symbol({
			toString() {
				record("coerce");
				throw error;
			},
		});
		record(value);
		return value.toString();
	} finally {
		record("finally");
	}
}
globalThis.escapingSymbolText = escapingSymbolText;
globalThis.escapingRegisteredSymbolText = escapingRegisteredSymbolText;
globalThis.suspendedEscapingSymbolText = suspendedEscapingSymbolText;
globalThis.abruptEscapingSymbolText = abruptEscapingSymbolText;
for (const input of [undefined, null, true, -0, 17n, "", "a😀\ud800z"]) {
	const events = [];
	const result = globalThis.escapingSymbolText(input, (event) => events.push(event));
	const text = String(input);
	check(
		events[0] === "extra" &&
			events[1] === "coerce:string" &&
			events[2] === result[0] &&
			events.length === 3,
		"escaping Symbol captures object coercion after argument effects exactly once",
	);
	check(
		result[1] === text && result[2] === `Symbol(${text})` && result[3] === result[2],
		"escaping Symbol metadata preserves captured UTF-16 text",
	);
	const again = globalThis.escapingSymbolText(input, () => {});
	check(
		again[0] !== result[0],
		"equal captured descriptions retain fresh Symbol identity",
	);
}
const registryEvents = [];
const registryKey = "captured-dynamic-registry-key";
const registryResult = globalThis.escapingRegisteredSymbolText(
	{
		[Symbol.toPrimitive](hint) {
			registryEvents.push(hint);
			return registryKey;
		},
	},
	(value) => registryEvents.push(value),
);
check(
	registryEvents.length === 2 &&
		registryEvents[0] === "string" &&
		registryEvents[1] === registryResult[0] &&
		Symbol.for(registryKey) === registryResult[0] &&
		registryResult[1] === registryKey &&
		registryResult[2] === `Symbol(${registryKey})` &&
		registryResult[3] === registryResult[2] &&
		registryResult[4] === registryKey,
	"metadata forwarding preserves registration and single registry-key coercion",
);
const symbolConversionFailure = {};
const abruptSymbolEvents = [];
try {
	globalThis.abruptEscapingSymbolText(symbolConversionFailure, (event) =>
		abruptSymbolEvents.push(event),
	);
	throw new Error("symbol conversion must throw");
} catch (error) {
	check(
		error === symbolConversionFailure &&
			abruptSymbolEvents.join(",") === "coerce,finally",
		"captured object coercion retains the original abrupt continuation",
	);
}
let escapedAfterConversionFailure = false;
try {
	globalThis.escapingSymbolText(
		{
			toString() {
				throw symbolConversionFailure;
			},
		},
		(event) => {
			if (typeof event === "symbol") escapedAfterConversionFailure = true;
		},
	);
	throw new Error("object returned from ToPrimitive must throw");
} catch (error) {
	check(
		error instanceof TypeError && !escapedAfterConversionFailure,
		"captured Symbol description rejects a nonprimitive conversion before escape",
	);
}
try {
	globalThis.escapingRegisteredSymbolText(
		{
			toString() {
				throw symbolConversionFailure;
			},
		},
		() => {
			throw new Error("registry symbol escaped after failed conversion");
		},
	);
	throw new Error("registry conversion must throw");
} catch (error) {
	check(
		error === symbolConversionFailure,
		"captured registry coercion preserves exceptions",
	);
}
const suspendedSymbolEvents = [];
const suspendedSymbol = globalThis.suspendedEscapingSymbolText("retained", (event) =>
	suspendedSymbolEvents.push(event),
);
const yieldedSymbol = suspendedSymbol.next();
check(
	!yieldedSymbol.done && typeof yieldedSymbol.value === "symbol",
	"symbol identity escapes through suspension",
);
if (typeof globalThis.gc === "function") globalThis.gc();
const resumedSymbol = suspendedSymbol.next();
check(
	resumedSymbol.done &&
		resumedSymbol.value[0] === yieldedSymbol.value &&
		resumedSymbol.value[1] === "retained" &&
		resumedSymbol.value[2] === "Symbol(retained)" &&
		resumedSymbol.value[3] === "Symbol(retained)" &&
		suspendedSymbolEvents.join(",") === "convert,resume",
	"captured Symbol text and identity survive suspension without recoercion",
);
const symbolTextMethod = Object.getOwnPropertyDescriptor(Symbol.prototype, "toString");
if (symbolTextMethod.writable) {
	const mutableSymbol = globalThis.suspendedEscapingSymbolText("mutable", () => {});
	mutableSymbol.next();
	try {
		Symbol.prototype.toString = () => "replaced";
		const observed = mutableSymbol.next().value;
		check(
			observed[2] === "replaced" && observed[3] === "Symbol(mutable)",
			"mutable Symbol text lookup remains distinct from String symbol conversion",
		);
	} finally {
		Object.defineProperty(Symbol.prototype, "toString", symbolTextMethod);
	}
}
function escapingOptionalSymbolText(input, record) {
	try {
		const value = Symbol(input, record("extra"));
		record(value);
		return [value, value.description, value.toString(), String(value)];
	} finally {
		record("finally");
	}
}
globalThis.escapingOptionalSymbolText = escapingOptionalSymbolText;
for (const input of [undefined, "", "undefined", null, false, -0, 7n, "x😀\ud800y"]) {
	const events = [];
	const result = globalThis.escapingOptionalSymbolText(input, (event) =>
		events.push(event),
	);
	const description = input === undefined ? undefined : String(input);
	check(
		result[1] === description &&
			result[2] === `Symbol(${description === undefined ? "" : description})` &&
			result[3] === result[2],
		"optional escaping Symbol distinguishes absent, empty, and undefined text",
	);
	check(
		events.length === 3 &&
			events[0] === "extra" &&
			events[1] === result[0] &&
			events[2] === "finally" &&
			globalThis.escapingOptionalSymbolText(input, () => {})[0] !== result[0],
		"optional description capture retains effects and fresh identity",
	);
}
const optionalSymbolEvents = [];
const optionalSymbolInput = {
	[Symbol.toPrimitive](hint) {
		optionalSymbolEvents.push(hint);
		return undefined;
	},
};
const optionalSymbolResult = globalThis.escapingOptionalSymbolText(
	optionalSymbolInput,
	(event) => {
		optionalSymbolEvents.push(event);
		if (typeof event === "symbol") {
			optionalSymbolInput[Symbol.toPrimitive] = () => {
				throw new Error("optional Symbol description coerced again");
			};
		}
	},
);
check(
	optionalSymbolResult[1] === "undefined" &&
		optionalSymbolResult[2] === "Symbol(undefined)" &&
		optionalSymbolResult[3] === "Symbol(undefined)" &&
		optionalSymbolEvents.length === 4 &&
		optionalSymbolEvents[0] === "extra" &&
		optionalSymbolEvents[1] === "string" &&
		optionalSymbolEvents[2] === optionalSymbolResult[0] &&
		optionalSymbolEvents[3] === "finally",
	"unknown input captures object conversion once before escape",
);
for (const input of [
	Symbol("rejected"),
	{
		toString() {
			throw symbolConversionFailure;
		},
	},
]) {
	const events = [];
	try {
		globalThis.escapingOptionalSymbolText(input, (event) => events.push(event));
		throw new Error("optional Symbol conversion must throw");
	} catch (error) {
		check(
			(typeof input === "symbol"
				? error instanceof TypeError
				: error === symbolConversionFailure) && events.join(",") === "extra,finally",
			"optional description conversion retains its original abrupt continuation",
		);
	}
}
function repeatZeroIdentity(input, record) {
	return String(input).repeat((record("count"), -0.9), record("extra"));
}
function repeatOneIdentity(input, record) {
	return String(input).repeat((record("count"), " 1.9 "), record("extra"));
}
function paddingIdentity(input, fill, record) {
	const text = String(input);
	return [
		text.padStart((record("start"), -Infinity), (record("fill-start"), fill)),
		text.padEnd((record("end"), NaN), (record("fill-end"), fill)),
	];
}
function fullStringRangeIdentity(input, record) {
	const text = String(input);
	return [
		text.slice(
			(record("slice-start"), -Infinity),
			(record("slice-end"), Infinity),
			record("slice-extra"),
		),
		text.substring(
			(record("substring-start"), -99),
			(record("substring-end"), undefined),
			record("substring-extra"),
		),
		text.concat(),
	];
}
function coerciveStringRange(input, start, end, record) {
	return String.prototype.slice.call(
		input,
		(record("start-argument"), start),
		(record("end-argument"), end),
		record("extra-argument"),
	);
}
function bigintStringRange(input, variant) {
	const text = String(input);
	if (variant === 0) return text.slice(0n, Infinity);
	if (variant === 1) return text.slice(0, 0n);
	if (variant === 2) return text.substring(0n, Infinity);
	if (variant === 3) return text.substring(0, 0n);
	return text.slice(Infinity, 0n);
}
function emptyStringRanges(input, record) {
	const text = String(input);
	return [
		text.slice((record("start"), 5), (record("end"), 2), record("extra")),
		text.slice(-2, -5),
		text.slice(Infinity),
		text.slice(0, -Infinity),
		text.substring(-2, -5),
		text.substring(2, 2),
		text.substring(Infinity, Infinity),
	];
}
function emptyStringNeedles(input, record) {
	const text = String(input);
	return [
		text.includes(
			(record("needle"), ""),
			(record("position"), Infinity),
			record("extra"),
		),
		text.startsWith("", -Infinity),
		text.endsWith("", undefined),
		text.includes("", "invalid"),
		text.startsWith("", null),
		text.endsWith("", "1.9"),
	];
}
function invalidEmptyNeedlePosition(input, variant) {
	const text = String(input);
	if (variant === 0) return text.includes("", 0n);
	if (variant === 1) return text.startsWith("", Symbol.iterator);
	return text.endsWith("", 0n);
}
function emptyNeedleWithObjectPosition(input, record) {
	return String(input).includes("", {
		valueOf() {
			record("position-coercion");
			return Infinity;
		},
	});
}
function regexpMarkedEmptyNeedle(input, record) {
	return String(input).startsWith(
		{
			get [Symbol.match]() {
				record("match");
				return true;
			},
			toString() {
				record("needle-coercion");
				return "";
			},
		},
		{
			valueOf() {
				record("position-coercion");
				return 0;
			},
		},
	);
}
function emptySuffixIdentity(input, record) {
	return String(input).concat(
		(record("first"), ""),
		(record("second"), ""),
		(record("third"), ""),
	);
}
function emptyFillIdentity(input, record) {
	const text = String(input);
	return [
		text.padStart(
			(record("start-length"), Infinity),
			(record("start-fill"), ""),
			record("start-extra"),
		),
		text.padEnd(
			(record("end-length"), "20"),
			(record("end-fill"), ""),
			record("end-extra"),
		),
	];
}
function substrIdentity(input, record) {
	const text = String(input);
	return [
		text.substr(
			(record("start"), -Infinity),
			(record("count"), Infinity),
			record("extra"),
		),
		text.substr(0),
		text.substr(
			(record("empty-start"), -2),
			(record("empty-count"), 0),
			record("empty-extra"),
		),
		text.substr(Infinity),
		text.substr(0, -1),
	];
}
function objectSuffixAndFill(input, record) {
	const text = String(input);
	return [
		text.concat({
			toString() {
				record("suffix");
				return "";
			},
		}),
		text.padEnd(Infinity, {
			toString() {
				record("fill");
				return "";
			},
		}),
		text.padStart(
			{
				valueOf() {
					record("length");
					return 5;
				},
			},
			"",
		),
	];
}
function invalidEmptyFillAndSubstr(input, variant) {
	const text = String(input);
	if (variant === 0) return text.padStart(0n, "");
	if (variant === 1) return text.padEnd(Symbol.iterator, "");
	if (variant === 2) return text.substr(0n, 0);
	return text.substr(Infinity, 0n);
}
globalThis.repeatZeroIdentity = repeatZeroIdentity;
globalThis.repeatOneIdentity = repeatOneIdentity;
globalThis.paddingIdentity = paddingIdentity;
globalThis.fullStringRangeIdentity = fullStringRangeIdentity;
globalThis.coerciveStringRange = coerciveStringRange;
globalThis.bigintStringRange = bigintStringRange;
globalThis.emptyStringRanges = emptyStringRanges;
globalThis.emptyStringNeedles = emptyStringNeedles;
globalThis.invalidEmptyNeedlePosition = invalidEmptyNeedlePosition;
globalThis.emptyNeedleWithObjectPosition = emptyNeedleWithObjectPosition;
globalThis.regexpMarkedEmptyNeedle = regexpMarkedEmptyNeedle;
globalThis.emptySuffixIdentity = emptySuffixIdentity;
globalThis.emptyFillIdentity = emptyFillIdentity;
globalThis.substrIdentity = substrIdentity;
globalThis.objectSuffixAndFill = objectSuffixAndFill;
globalThis.invalidEmptyFillAndSubstr = invalidEmptyFillAndSubstr;
for (const text of ["", "hello", "😀\ud800\udfff", "\0x"]) {
	const events = [];
	const input = {
		toString() {
			events.push("receiver");
			return text;
		},
	};
	const record = (event) => events.push(event);
	check(globalThis.repeatZeroIdentity(input, record) === "", "repeat zero result");
	check(events.join(",") === "receiver,count,extra", "repeat zero conversion order");
	events.length = 0;
	check(
		globalThis.repeatOneIdentity(input, record) === text,
		"repeat one preserves UTF-16",
	);
	check(events.join(",") === "receiver,count,extra", "repeat one conversion order");
	events.length = 0;
	const fill = {
		toString() {
			throw new Error("zero-length padding must not convert its filler");
		},
	};
	const padded = globalThis.paddingIdentity(input, fill, record);
	check(padded[0] === text && padded[1] === text, "nonpositive padding preserves input");
	check(
		events.join(",") === "receiver,start,fill-start,end,fill-end",
		"padding keeps filler producer effects without filler coercion",
	);
	events.length = 0;
	const ranged = globalThis.fullStringRangeIdentity(input, record);
	check(
		ranged.every((value) => value === text),
		"full ranges and empty concat preserve UTF-16",
	);
	check(
		events.join(",") ===
			"receiver,slice-start,slice-end,slice-extra,substring-start,substring-end,substring-extra",
		"full string ranges keep bound and extra argument producer order",
	);
	events.length = 0;
	check(
		globalThis.emptyStringRanges(input, record).every((value) => value === ""),
		"equal and reversed normalized ranges are empty at every string length",
	);
	check(events.join(",") === "receiver,start,end,extra", "empty ranges preserve effects");
	events.length = 0;
	check(
		globalThis.emptyStringNeedles(input, record).every((value) => value === true),
		"empty string needles match at every clamped position",
	);
	check(
		events.join(",") === "receiver,needle,position,extra",
		"empty needle searches preserve effects",
	);
	events.length = 0;
	check(
		globalThis.emptyNeedleWithObjectPosition(input, record) === true &&
			events.join(",") === "receiver,position-coercion",
		"empty needle retains object position conversion",
	);
	events.length = 0;
	try {
		globalThis.regexpMarkedEmptyNeedle(input, record);
		throw new Error("regexp-marked empty needle must fail");
	} catch (error) {
		check(
			error instanceof TypeError && events.join(",") === "receiver,match",
			"IsRegExp failure precedes needle and position coercion",
		);
	}
	events.length = 0;
	check(
		globalThis.emptySuffixIdentity(input, record) === text,
		"empty concat suffixes preserve input",
	);
	check(
		events.join(",") === "receiver,first,second,third",
		"empty concat suffix producer order",
	);
	events.length = 0;
	check(
		globalThis.emptyFillIdentity(input, record).every((value) => value === text),
		"empty filler preserves input before any maximum padding length check",
	);
	check(
		events.join(",") ===
			"receiver,start-length,start-fill,start-extra,end-length,end-fill,end-extra",
		"empty filler keeps length, filler and extra argument producer order",
	);
	events.length = 0;
	const substrings = globalThis.substrIdentity(input, record);
	check(
		substrings[0] === text &&
			substrings[1] === text &&
			substrings.slice(2).every((value) => value === ""),
		"substr distinguishes a character count from an end index",
	);
	check(
		events.join(",") === "receiver,start,count,extra,empty-start,empty-count,empty-extra",
		"substr preserves both bound and extra argument producers",
	);
	events.length = 0;
	check(
		globalThis.objectSuffixAndFill(input, record).every((value) => value === text) &&
			events.join(",") === "receiver,suffix,fill,length",
		"empty suffix and filler results retain object coercions",
	);
}
const repeatConversionFailure = {};
const repeatFailureEvents = [];
try {
	globalThis.repeatZeroIdentity(
		{
			toString() {
				throw repeatConversionFailure;
			},
		},
		(event) => repeatFailureEvents.push(event),
	);
	throw new Error("repeat zero must retain receiver conversion failure");
} catch (error) {
	check(
		error === repeatConversionFailure && repeatFailureEvents.length === 0,
		"receiver conversion failure precedes repeat arguments",
	);
}
const stringRangeEvents = [];
const stringRangeInput = {
	toString() {
		stringRangeEvents.push("receiver");
		return "😀\ud800tail";
	},
};
const stringRangeStart = {
	valueOf() {
		stringRangeEvents.push("start-conversion");
		return -Infinity;
	},
};
const stringRangeEnd = {
	valueOf() {
		stringRangeEvents.push("end-conversion");
		return Infinity;
	},
};
check(
	globalThis.coerciveStringRange(
		stringRangeInput,
		stringRangeStart,
		stringRangeEnd,
		(event) => stringRangeEvents.push(event),
	) === "😀\ud800tail",
	"unknown receiver and object bounds retain full-range result",
);
check(
	stringRangeEvents.join(",") ===
		"start-argument,end-argument,extra-argument,receiver,start-conversion,end-conversion",
	"range receiver and bound coercions remain after all argument producers",
);
for (const input of ["", "text"]) {
	for (let variant = 0; variant < 5; variant++) {
		try {
			globalThis.bigintStringRange(input, variant);
			throw new Error("BigInt range bound must fail");
		} catch (error) {
			check(error instanceof TypeError, "BigInt range bound retains TypeError");
		}
	}
	for (let variant = 0; variant < 3; variant++) {
		try {
			globalThis.invalidEmptyNeedlePosition(input, variant);
			throw new Error("empty needle still requires numeric position conversion");
		} catch (error) {
			check(
				error instanceof TypeError,
				"empty needle retains BigInt and Symbol position errors",
			);
		}
	}
	for (let variant = 0; variant < 4; variant++) {
		try {
			globalThis.invalidEmptyFillAndSubstr(input, variant);
			throw new Error("empty filler and substr still require numeric conversion");
		} catch (error) {
			check(
				error instanceof TypeError,
				"empty filler and substr retain numeric conversion errors",
			);
		}
	}
}
for (const method of ["repeat", "padStart", "padEnd"]) {
	try {
		String.prototype[method].call("text", 0n);
		throw new Error("BigInt string builder count must fail");
	} catch (error) {
		check(error instanceof TypeError, "BigInt string builder count retains TypeError");
	}
}
function staticBigintPowers() {
	return [
		0n ** 0n,
		3n ** 40n,
		(-2n) ** 127n,
		(-1n) ** 170141183460469231731687303715884105727n,
	];
}
globalThis.staticBigintPowers = staticBigintPowers;
const powers = globalThis.staticBigintPowers();
check(
	powers[0] === 1n &&
		powers[1] === 12157665459056928801n &&
		powers[2] === -170141183460469231731687303715884105728n &&
		powers[3] === -1n,
	"bounded BigInt powers retain exact values",
);
function bigintPowerEffects(record) {
	return (record("base"), 3n) ** (record("exponent"), 4n);
}
globalThis.bigintPowerEffects = bigintPowerEffects;
const powerEvents = [];
check(
	globalThis.bigintPowerEffects((event) => powerEvents.push(event)) === 81n &&
		powerEvents.join(",") === "base,exponent",
	"folded BigInt powers retain operand producer order",
);
for (const evaluate of [() => 0n ** -1n, () => 1n ** -1n, () => (-1n) ** -1n]) {
	let threw = false;
	try {
		evaluate();
	} catch (error) {
		threw = error instanceof RangeError;
	}
	check(threw, "negative BigInt exponent retains RangeError");
}
function zeroWidthBigint(value) {
	return [
		BigInt.asIntN(0, BigInt(value)),
		BigInt.asUintN(0.9, !!value),
		BigInt.asIntN(-0.9, !!value),
		BigInt.asUintN(undefined, BigInt(value)),
	];
}
globalThis.zeroWidthBigint = zeroWidthBigint;
check(
	globalThis.zeroWidthBigint("19").every((value) => value === 0n),
	"zero-width narrowing keeps exact bigint zero",
);
const zeroWidthEvents = [];
function zeroWidthEffects(value, extra) {
	return BigInt.asIntN(0, BigInt(value()), extra());
}
globalThis.zeroWidthEffects = zeroWidthEffects;
check(
	globalThis.zeroWidthEffects(
		() => (zeroWidthEvents.push("value"), 19n),
		() => zeroWidthEvents.push("extra"),
	) === 0n && zeroWidthEvents.join(":") === "value:extra",
	"zero-width narrowing preserves producer and extra argument order",
);
zeroWidthEvents.length = 0;
let zeroWidthProducerThrew = false;
try {
	globalThis.zeroWidthEffects(
		() => (zeroWidthEvents.push("value"), "invalid"),
		() => zeroWidthEvents.push("extra"),
	);
} catch (error) {
	zeroWidthProducerThrew = error instanceof SyntaxError;
}
check(
	zeroWidthProducerThrew && zeroWidthEvents.join(":") === "value",
	"zero-width narrowing preserves abrupt producer completion before later arguments",
);
for (const method of ["asIntN", "asUintN"]) {
	for (const value of [1, null, undefined, Symbol("width-value")]) {
		let rejected = false;
		try {
			BigInt[method](0, value);
		} catch (error) {
			rejected = error instanceof TypeError;
		}
		check(rejected, "zero width still rejects values that cannot convert to BigInt");
	}
	let invalidString = false;
	try {
		BigInt[method](0, "invalid");
	} catch (error) {
		invalidString = error instanceof SyntaxError;
	}
	check(invalidString, "zero width still parses string values");
	const events = [];
	check(
		BigInt[method](0, {
			valueOf() {
				events.push("convert");
				return 9n;
			},
		}) === 0n && events.join(":") === "convert",
		"zero width retains object-to-BigInt conversion",
	);
	let invalidWidth = false;
	try {
		BigInt[method](0n, 1n);
	} catch (error) {
		invalidWidth = error instanceof TypeError;
	}
	check(invalidWidth, "BigInt width is rejected before narrowing");
}
check(
	BigInt.asIntN(1, true) === -1n && BigInt.asUintN(128, 9n) === 9n,
	"nonzero widths retain their result",
);
console.log("primitive identities passed");
