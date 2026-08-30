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
console.log("finite-call-target-dispatch PASS");
