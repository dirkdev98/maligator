let passed = 0;
function realmCallCacheThis() {
	return globalThis;
}
globalThis.__realmCallCacheThis = realmCallCacheThis;
function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}
function throwsTypeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

const methods = [
	"push",
	"pop",
	"shift",
	"unshift",
	"flat",
	"flatMap",
	"splice",
	"toSpliced",
	"copyWithin",
	"with",
	"toReversed",
	"toString",
	"toLocaleString",
	"values",
	"keys",
	"entries",
];
for (const name of methods) {
	ok(
		name + " rejects null",
		throwsTypeError(() => Array.prototype[name].call(null)),
	);
}

let callbackReceiver;
const mapped = Array.prototype.flatMap.call("ab", (value, index, receiver) => {
	callbackReceiver = receiver;
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
	return [value, index];
});
ok("flatMap boxes callback receiver", typeof callbackReceiver === "object");
ok("flatMap string result", mapped.join(":") === "a:0:b:1");

ok("flat string", Array.prototype.flat.call("ab").join("") === "ab");
ok(
	"toSpliced string",
	Array.prototype.toSpliced.call("ab", 1, 0, "x").join("") === "axb",
);
ok("with string", Array.prototype.with.call("ab", 0, "x").join("") === "xb");
ok("toReversed string", Array.prototype.toReversed.call("ab").join("") === "ba");
ok("toLocaleString string", Array.prototype.toLocaleString.call("ab") === "a,b");
ok("toString boxes string", Array.prototype.toString.call("ab") === "[object String]");

const iterator = Array.prototype.values.call("ab");
ok(
	"iterator boxes string",
	iterator.next().value === "a" && iterator.next().value === "b",
);

ok("push boxes number", Array.prototype.push.call(1, "x") === 1);
ok("pop boxes number", Array.prototype.pop.call(1) === undefined);
ok("shift boxes number", Array.prototype.shift.call(1) === undefined);
ok("unshift boxes number", Array.prototype.unshift.call(1, "x") === 1);
ok("splice boxes number", Array.prototype.splice.call(1, 0, 0).length === 0);
ok(
	"copyWithin returns wrapper",
	typeof Array.prototype.copyWithin.call(1, 0) === "object",
);
ok(
	"string mutation rejects exotic",
	throwsTypeError(() => Array.prototype.push.call("ab", "x")),
);
ok(
	"string copy rejects exotic",
	throwsTypeError(() => Array.prototype.copyWithin.call("ab", 0, 1)),
);

const order = [];
const arrayLike = {
	get length() {
		order.push("length");
		return 1;
	},
	0: [1],
};
const depth = {
	valueOf() {
		order.push("depth");
		return 1;
	},
};
ok(
	"flat operation order",
	Array.prototype.flat.call(arrayLike, depth)[0] === 1 &&
		order.join(",") === "length,depth",
);

const sortOrder = [];
const sortable = {
	get length() {
		sortOrder.push("length");
		return 0;
	},
};
ok(
	"sort comparator order",
	throwsTypeError(() => Array.prototype.sort.call(sortable, 0)) && sortOrder.length === 0,
);
sortOrder.length = 0;
ok(
	"toSorted comparator order",
	throwsTypeError(() => Array.prototype.toSorted.call(sortable, 0)) &&
		sortOrder.length === 0,
);

console.log("array-to-object PASS " + passed + "/" + passed);
