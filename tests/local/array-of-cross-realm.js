const other = $262.createRealm().global;

function check(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

const C = new other.Function();
C.prototype = null;
const foreign = Array.of.call(C, 1, 2, 3);
check(
	Object.getPrototypeOf(foreign) === other.Object.prototype,
	"foreign constructor fallback prototype",
);
check(
	foreign.length === 3 && foreign[0] === 1 && foreign[2] === 3,
	"foreign constructor contents",
);

let constructorLength = -1;
function Custom(length) {
	constructorLength = length;
}
const custom = Array.of.call(Custom, "a", "b");
check(custom instanceof Custom, "custom constructor result");
check(constructorLength === 2 && custom.length === 2, "custom constructor length");
check(custom[0] === "a" && custom[1] === "b", "custom constructor properties");

const definitions = [];
function ProxyResult(length) {
	check(length === 2, "proxy result constructor length");
	const target = {};
	return new Proxy(target, {
		defineProperty(target, key, descriptor) {
			definitions.push(String(key));
			$262.gc();
			return Reflect.defineProperty(target, key, descriptor);
		},
	});
}
const proxyResult = Array.of.call(ProxyResult, 4, 5);
check(
	proxyResult[0] === 4 && proxyResult[1] === 5 && proxyResult.length === 2,
	"proxy result values",
);
check(definitions[0] === "0" && definitions[1] === "1", "CreateDataProperty order");
check(definitions.includes("length"), "length Set after indexed definitions");

let proxyConstructs = 0;
const proxyConstructor = new Proxy(C, {
	construct(target, args, newTarget) {
		proxyConstructs++;
		$262.gc();
		return Reflect.construct(target, args, newTarget);
	},
});
const throughProxy = Array.of.call(proxyConstructor, 6);
check(proxyConstructs === 1, "proxy constructor invocation");
check(
	Object.getPrototypeOf(throughProxy) === other.Object.prototype,
	"proxy constructor realm",
);

other.calls = 0;
const nonConstructor = other.eval("(() => { calls++; })");
const fallback = Array.of.call(nonConstructor, 7);
check(other.calls === 0, "non-constructor callable was not called");
check(
	Object.getPrototypeOf(fallback) === Array.prototype,
	"non-constructor callable fallback realm",
);

const primitiveFallback = Array.of.call(1, 8);
check(
	Object.getPrototypeOf(primitiveFallback) === Array.prototype,
	"primitive fallback realm",
);

const revoked = Proxy.revocable(C, {});
revoked.revoke();
for (const operation of [
	() => Array.of.call(revoked.proxy, 9),
	() => Array.from.call(revoked.proxy, [9]),
]) {
	try {
		operation();
		throw new Error("revoked constructor proxy did not throw");
	} catch (error) {
		check(error instanceof TypeError, "revoked proxy error realm");
	}
}

const Throw = other.eval("(function Throw() { throw new TypeError('foreign'); })");
try {
	Array.of.call(Throw, 10);
	throw new Error("foreign constructor did not throw");
} catch (error) {
	check(error instanceof other.TypeError, "constructor throw realm");
}

console.log("array-of-cross-realm PASS 1/1");
