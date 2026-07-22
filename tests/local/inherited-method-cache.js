let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function loadGetTime(date) {
	return date.getTime;
}

function callGetTime(date) {
	return date.getTime();
}

const first = new Date(17);
const originalGetTime = Date.prototype.getTime;
for (let i = 0; i < 2000; i++) {
	ok("repeated inherited load", loadGetTime(first) === originalGetTime);
	ok("repeated inherited native call", callGetTime(first) === 17);
}

first.getTime = function () {
	return 23;
};
ok("own shadow misses inherited cache", callGetTime(first) === 23);

const second = new Date(29);
for (let i = 0; i < 20; i++) ok("second receiver warms", callGetTime(second) === 29);
Object.setPrototypeOf(second, {
	getTime() {
		return 31;
	},
});
ok("direct prototype replacement misses", callGetTime(second) === 31);

function setTime(date, value) {
	return date.setTime(value);
}
const mutable = new Date(0);
ok("native arguments first", setTime(mutable, 41) === 41);
ok("native arguments cached", setTime(mutable, 43) === 43 && mutable.getTime() === 43);

function iso(date) {
	return date.toISOString();
}
ok("native completion warm", iso(new Date(0)) === "1970-01-01T00:00:00.000Z");
let rangeError = false;
try {
	iso(new Date(NaN));
} catch (error) {
	rangeError = error instanceof RangeError;
}
ok("native throw completion propagates", rangeError);
ok("completion clears after catch", iso(new Date(0)) === "1970-01-01T00:00:00.000Z");

function invoke(callable, value) {
	return callable(value);
}
ok("native dynamic call warms", invoke(Number, "47") === 47);
const bound = ((value) => value + 1).bind(undefined);
ok("bound callable falls back", invoke(bound, 47) === 48);
const proxied = new Proxy((value) => value + 2, {});
ok("proxy callable falls back", invoke(proxied, 47) === 49);

const gc = globalThis.__mal_collect_garbage;
function mapValues(values, callback) {
	return values.map(callback);
}
for (let pass = 0; pass < 2; pass++) {
	const mapped = mapValues([1, 2, 3], (value) => {
		const result = { value: value + pass };
		if (typeof gc === "function") gc();
		return result;
	});
	ok("native callback survives GC", mapped[2].value === 3 + pass);
}

const realmOne = new ShadowRealm();
const realmTwo = new ShadowRealm();
const fromRealmOne = realmOne.evaluate("() => new Date(53).getTime()");
const fromRealmTwo = realmTwo.evaluate("() => new Date(59).getTime()");
function invokeRealm(callback) {
	return callback();
}
ok("cross-realm native wrapper first", invokeRealm(fromRealmOne) === 53);
ok("cross-realm native wrapper second", invokeRealm(fromRealmTwo) === 59);
ok("cross-realm native wrapper returns", invokeRealm(fromRealmOne) === 53);

function loadToString(object) {
	return object.toString;
}
const plain = { value: 1 };
const originalToString = Object.prototype.toString;
for (let i = 0; i < 20; i++) {
	ok("plain object inherited warm", loadToString(plain) === originalToString);
}
Object.prototype.toString = function () {
	return "patched";
};
ok("plain object inherited invalidation", loadToString(plain)() === "patched");
Object.prototype.toString = originalToString;

ok("checks ran", passed > 4000);
console.log("inherited-method-cache PASS");
