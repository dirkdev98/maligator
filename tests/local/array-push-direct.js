let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("array-push-direct failure: " + name);
	checks++;
}

const dense = [1];
ok("multi argument return", dense.push(2, 3, 4) === 4);
ok("multi argument values", dense.join(",") === "1,2,3,4");
ok("zero argument return", dense.push() === 4);

function exactFreshPush(a, b, c) {
	return [10].push(a, b, c);
}
ok("locked exact fresh push", exactFreshPush(1, 2, 3) === 4);

const collected = [];
for (let i = 0; i < 3000; i++) collected.push({ value: i });
let sum = 0;
for (let i = 0; i < collected.length; i++) sum += collected[i].value;
ok("gc rooted values", sum === (2999 * 3000) / 2);

const own = [];
own.push = function (value) {
	this[0] = value * 2;
	return 77;
};
ok("own override", own.push(5) === 77 && own[0] === 10 && own.length === 1);

const intrinsicPush = Array.prototype.push;
Array.prototype.push = function (value) {
	this[0] = value + 1;
	return 88;
};
const overridden = [];
ok(
	"prototype override",
	overridden.push(6) === 88 && overridden[0] === 7 && overridden.length === 1,
);
Array.prototype.push = intrinsicPush;

const mutation = [];
const mutationResult = mutation.push(
	((Array.prototype.push = function () {
		return 99;
	}),
	7),
);
Array.prototype.push = intrinsicPush;
ok("mutation after method load", mutationResult === 1 && mutation[0] === 7);

let getterCalls = 0;
const accessor = [];
Object.defineProperty(accessor, "push", {
	configurable: true,
	get() {
		getterCalls++;
		return function () {
			return 66;
		};
	},
});
ok(
	"method accessor",
	accessor.push(1) === 66 && getterCalls === 1 && accessor.length === 0,
);

class PushArray extends Array {
	push(value) {
		this[0] = value * 3;
		return 55;
	}
}
const subclass = new PushArray();
ok("subclass override", subclass.push(4) === 55 && subclass[0] === 12);

const proxyTarget = [];
const proxy = new Proxy(proxyTarget, {});
ok("proxy receiver", proxy.push(9) === 1 && proxyTarget[0] === 9);

const frozen = Object.freeze([]);
let frozenThrew = false;
try {
	frozen.push(1);
} catch (error) {
	frozenThrew = error instanceof TypeError;
}
ok("frozen fallback", frozenThrew && frozen.length === 0);

const sealed = Object.preventExtensions([]);
let sealedThrew = false;
try {
	sealed.push(1);
} catch (error) {
	sealedThrew = error instanceof TypeError;
}
ok("non-extensible fallback", sealedThrew && sealed.length === 0);

const sparse = [];
sparse[5000] = 1;
ok("sparse fallback", sparse.push(2) === 5002 && sparse[5001] === 2);

const maxLength = [];
maxLength.length = 4294967295;
let maxLengthThrew = false;
try {
	maxLength.push(1);
} catch (error) {
	maxLengthThrew = error instanceof RangeError;
}
ok("large length fallback", maxLengthThrew && maxLength.length === 4294967295);

ok("check count", checks === 15);
console.log("array-push-direct PASS");
