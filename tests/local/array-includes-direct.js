function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label + ": " + actual);
}

function includes(array, value, fromIndex) {
	return array.includes(value, fromIndex);
}

for (let index = 0; index < 2000; index++) {
	check(includes(["gte"], "gte"), true, "singleton hit");
	check(includes(["gte"], "lt"), false, "singleton miss");
}
const object = {};
const symbol = Symbol("fictional");
const dense = [NaN, -0, undefined, "fictional", 3n, object, symbol];
for (const value of dense) check(includes(dense, value), true, "SameValueZero hit");
check(includes(dense, {}), false, "object identity");
check(includes(dense, Symbol("fictional")), false, "symbol identity");
check(includes(dense, 3), false, "BigInt and Number differ");
check(includes(dense, "fic" + "tional"), true, "string contents");
const large = Array.from({ length: 128 }, (_, index) => index);
check(includes(large, 64), true, "vector hit");
check(includes(large, 128), false, "vector miss");
check(includes(large, 0, -Infinity), true, "negative infinity");
check(includes(large, 0, Infinity), false, "positive infinity");
check(includes(large, 0, NaN), true, "NaN index");
check(includes(large, 127, -1.9), true, "negative fractional index");
check(includes(large, 64, 64.9), true, "positive fractional index");
check(includes(large, 0, -200), true, "negative index before start");
check(includes(large, 127, 128), false, "index past end");
check(includes([, 1], undefined), true, "dense hole");
const sparse = [];
sparse.length = 100;
check(includes(sparse, undefined, 99), true, "sparse tail");
check(includes(sparse, undefined, 100), false, "sparse end");
check(includes(Object.freeze([1, 2]), 2), true, "frozen array");
check(includes(Object.seal([1, 2]), 3), false, "sealed array");
check(
	includes([], 0, {
		valueOf() {
			throw new Error("empty conversion");
		},
	}),
	false,
	"empty skips coercion",
);
const mutation = [1, 2];
check(
	includes(mutation, 3, {
		valueOf() {
			mutation[1] = 3;
			return 0;
		},
	}),
	true,
	"coercion mutation",
);
const shrinking = [1, 2];
check(
	includes(shrinking, undefined, {
		valueOf() {
			shrinking.length = 0;
			return 1;
		},
	}),
	true,
	"snapped length after coercion",
);
const growing = [1];
check(
	includes(growing, 2, {
		valueOf() {
			growing.push(2);
			return 0;
		},
	}),
	false,
	"snapped length before growth",
);
check(includes([1, 2], 2, "1"), true, "string index conversion");
for (const fromIndex of [1n, Symbol("from")]) {
	let threw = false;
	try {
		includes([1], 1, fromIndex);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	check(threw, true, "reject invalid index");
}
const observed = [];
const proxy = new Proxy([1, 2], {
	get(target, key, receiver) {
		observed.push(String(key));
		return Reflect.get(target, key, receiver);
	},
});
check(includes(proxy, 2), true, "proxy hit");
check(observed.join(","), "includes,length,0,1", "proxy access order");
const revoked = Proxy.revocable([1], {});
revoked.revoke();
let revokedThrew = false;
try {
	includes(revoked.proxy, 1);
} catch (error) {
	revokedThrew = error instanceof TypeError;
}
check(revokedThrew, true, "revoked proxy");
const accessor = [1, 2];
Object.defineProperty(accessor, "0", {
	get() {
		accessor[1] = 4;
		return 1;
	},
});
check(includes(accessor, 4), true, "indexed getter mutation");
const callbackArray = [0, 1, 2];
check(
	callbackArray.some((value, index, array) => {
		array[index] = value + 10;
		return includes(array, 12);
	}),
	true,
	"callback mutation visible to search",
);
const original = Array.prototype.includes;
Array.prototype.includes = function (value) {
	return this[0] === value ? "patched hit" : "patched miss";
};
check(includes([7], 7), "patched hit", "patched prototype method");
Array.prototype.includes = original;
const own = [1];
own.includes = () => "own";
check(includes(own, 1), "own", "own method");
let methodReads = 0;
Object.defineProperty(own, "includes", {
	get() {
		methodReads++;
		return original;
	},
});
check(includes(own, 1), true, "method getter");
check(methodReads, 1, "method read once");
check(includes("fictional", "tion"), true, "String fallback");
check(includes(new Uint8Array([1, 2]), 2), true, "TypedArray fallback");
const generic = { 0: 8, length: 1, includes: original };
check(includes(generic, 8), true, "generic receiver");
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		return "inherited";
	},
});
try {
	check(includes([,], "inherited"), true, "inherited indexed getter");
	check(includes([,], undefined), false, "hole reads inherited value");
} finally {
	delete Array.prototype[0];
}
console.log("array-includes-direct PASS");
