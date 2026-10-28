let checks = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	checks++;
}

function holder() {}
holder.bias = 10;

function first(value) {
	if (value < 0) throw new Error("first throw");
	return this.bias + value + 1;
}

function second(value) {
	return this.bias + value + 2;
}

holder.run = first;
function invoke(value) {
	return holder.run(value);
}

ok("first guarded target", invoke(1) === 12);
try {
	invoke(-1);
	throw new Error("missing throw");
} catch (error) {
	ok("guarded throw", error.message === "first throw");
}

holder.run = second;
ok("alternate guarded target", invoke(1) === 13);

holder.run = Math.abs;
ok("generic mismatch fallback", invoke(-42) === 42);

const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") gc();
holder.run = second;
ok("post-GC guarded target", invoke(30) === 42);

ok("checks ran", checks === 5);

const makeCallback = function makeCallback(visit, bias) {
	for (let i = 0; i < 3; i++) visit();
	return function callback(value) {
		return bias + value;
	};
};
function returnedCallability(visit) {
	const value = makeCallback(visit, 40);
	return [typeof value === "function", typeof value === "object", typeof value];
}
globalThis.returnedCallability = returnedCallability;
let visits = 0;
const category = returnedCallability(() => {
	visits++;
	if (typeof gc === "function") gc();
});
ok("returned callable category", category.join(",") === "true,false,function");
ok("callability observation retains callback effects", visits === 3);
const observationError = {};
try {
	returnedCallability(() => {
		throw observationError;
	});
	throw new Error("missing callback error");
} catch (error) {
	ok("callability observation retains callback errors", error === observationError);
}
const makeClass = function makeClass(visit) {
	for (let i = 0; i < 3; i++) visit();
	return class Callback {};
};
const Callback = makeClass(() => {});
ok("class remains callable for typeof", typeof Callback === "function");
try {
	Callback();
	throw new Error("missing class invocation error");
} catch (error) {
	ok("callability does not remove class invocation errors", error instanceof TypeError);
}
const makeGenerator = function* makeGenerator() {
	return function returned(value) {
		return value + 1;
	};
};
const generator = makeGenerator();
ok("generator invocation returns a noncallable iterator", typeof generator === "object");
const returnedCallback = generator.next().value;
ok("generator body return retains its function", returnedCallback(41) === 42);
try {
	makeGenerator()();
	throw new Error("missing generator wrapper invocation error");
} catch (error) {
	ok(
		"generator wrapper cannot enter its callable body return",
		error instanceof TypeError,
	);
}
const makeAsync = async function makeAsync() {
	return function returned(value) {
		return value + 1;
	};
};
ok("async invocation returns a noncallable Promise", typeof makeAsync() === "object");
try {
	makeAsync()();
	throw new Error("missing async wrapper invocation error");
} catch (error) {
	ok("async wrapper cannot enter its callable body return", error instanceof TypeError);
}
const revoked = Proxy.revocable(() => 1, {});
revoked.revoke();
ok("revocation preserves callability", typeof revoked.proxy === "function");
console.log("finite-call-target-dispatch PASS");
