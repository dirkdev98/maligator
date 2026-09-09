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
console.log("primitive identities passed");
