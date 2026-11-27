let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function loadStringMethod(value) {
	return value.charCodeAt;
}

function loadNumberMethod(value) {
	return value.toFixed;
}

function loadStringLength(value) {
	return value.length;
}

function loadArrayLength(value) {
	return value.length;
}

function loadDynamic(value, key) {
	return value[key];
}

const originalCharCodeAt = String.prototype.charCodeAt;
const originalToFixed = Number.prototype.toFixed;
for (let i = 0; i < 500; i++) {
	ok("string primitive method", loadStringMethod("cache") === originalCharCodeAt);
	ok("number primitive method", loadNumberMethod(i) === originalToFixed);
	ok(
		"string length",
		loadStringLength(i % 2 === 0 ? "a" : "cache") === (i % 2 === 0 ? 1 : 5),
	);
}

const array = [];
for (let i = 0; i < 500; i++) {
	ok("array length observes growth", loadArrayLength(array) === i);
	array.push(i);
}

let proxyGets = 0;
const arrayProxy = new Proxy(array, {
	get(target, key, receiver) {
		proxyGets++;
		return Reflect.get(target, key, receiver);
	},
});
ok(
	"array proxy does not hit length cache",
	loadArrayLength(arrayProxy) === 500 && proxyGets === 1,
);

for (let i = 0; i < 300; i++) {
	const stringKey =
		i % 3 === 0
			? ["len", "gth"].join("")
			: i % 3 === 1
				? ["char", "Code", "At"].join("")
				: ["miss", "ing"].join("");
	const stringResult = loadDynamic("cache", stringKey);
	ok(
		"alternating string keys",
		stringResult ===
			(stringKey === "length"
				? 5
				: stringKey === "charCodeAt"
					? originalCharCodeAt
					: undefined),
	);

	const arrayKey = i % 2 === 0 ? ["len", "gth"].join("") : ["miss", "ing"].join("");
	ok(
		"alternating array keys",
		loadDynamic(array, arrayKey) === (arrayKey === "length" ? 500 : undefined),
	);
}

const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const ownMethod = function () {
	return "own";
};
const boxed = Object("cache");
boxed.charCodeAt = ownMethod;
let mixedGets = 0;
const getterReceiver = {
	get charCodeAt() {
		mixedGets++;
		collect();
		return ownMethod;
	},
};
let mixedProxyGets = 0;
const proxyReceiver = new Proxy(
	{ charCodeAt: ownMethod },
	{
		get(target, key, receiver) {
			mixedProxyGets++;
			return Reflect.get(target, key, receiver);
		},
	},
);
const mixed = [
	["cache", originalCharCodeAt],
	[boxed, ownMethod],
	[7, undefined],
	[getterReceiver, ownMethod],
	[true, undefined],
	[proxyReceiver, ownMethod],
	[Symbol("receiver"), undefined],
	[7n, undefined],
];
const rounds = 40;
for (let round = 0; round < rounds; round++)
	for (const [receiver, expected] of mixed)
		ok("one site observes each receiver kind", loadStringMethod(receiver) === expected);
ok("mixed accessor runs per read", mixedGets === rounds);
ok("mixed proxy runs per read", mixedProxyGets === rounds);
ok(
	"primitive row recovers after mixed receivers",
	loadStringMethod("cache") === originalCharCodeAt,
);

const dictionary = { charCodeAt: ownMethod };
Object.defineProperty(dictionary, "0", { value: 0 });
for (let i = 0; i < rounds; i++) {
	ok(
		"the primitive site can cache dictionary data",
		loadStringMethod(dictionary) === ownMethod,
	);
}
delete dictionary.charCodeAt;
ok("a deleted dictionary entry stays absent", loadStringMethod(dictionary) === undefined);

const prototype = Object.create(null);
const child = Object.assign(Object.create(prototype), { method: ownMethod });
const sibling = Object.assign(Object.create(prototype), { method: originalCharCodeAt });
for (let i = 0; i < rounds; i++) {
	ok("the same site can cache absence", loadStringMethod(child) === undefined);
}
let inheritedGets = 0;
Object.defineProperty(prototype, "charCodeAt", {
	configurable: true,
	get() {
		inheritedGets++;
		return this.method;
	},
});
for (let i = 0; i < rounds; i++) {
	ok("a new prototype getter receives the child", loadStringMethod(child) === ownMethod);
	ok(
		"the cached getter receives each receiver",
		loadStringMethod(sibling) === originalCharCodeAt,
	);
}
ok("the getter runs on every read", inheritedGets === rounds * 2);
delete prototype.charCodeAt;
for (let i = 0; i < rounds; i++) {
	ok("a deleted prototype getter stays absent", loadStringMethod(child) === undefined);
}
Object.setPrototypeOf(child, { charCodeAt: ownMethod });
ok("a replacement prototype invalidates absence", loadStringMethod(child) === ownMethod);

let numberGets = 0;
Object.defineProperty(Number.prototype, "toFixed", {
	configurable: true,
	get() {
		numberGets++;
		return function () {
			return "accessor";
		};
	},
});
ok("number accessor first load", loadNumberMethod(1)() === "accessor");
ok(
	"number accessor runs per load",
	loadNumberMethod(2)() === "accessor" && numberGets === 2,
);

String.prototype.charCodeAt = function () {
	return 97;
};
ok("string method replacement", loadStringMethod("cache")(0) === 97);

ok("checks ran", passed > 2500);
console.log("primitive-load-cache PASS");
