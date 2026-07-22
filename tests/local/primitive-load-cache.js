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
