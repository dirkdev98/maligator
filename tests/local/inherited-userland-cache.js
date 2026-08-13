let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function original(value) {
	return value + 1;
}

function replacement(value) {
	return value + 2;
}

function shadow(value) {
	return value + 3;
}

function loadDirect(receiver) {
	return receiver.method;
}

function loadDeep(receiver) {
	return receiver.method;
}

function loadLoop(receiver, count, initial) {
	let result = initial;
	for (let index = 0; index < count; index++) result = receiver.method;
	return result;
}

const holder = { method: original };
const direct = Object.create(holder);
const middle = Object.create(holder);
const deep = Object.create(middle);
const zeroSentinel = {};

ok("loop zero iterations", loadLoop(direct, 0, zeroSentinel) === zeroSentinel);
ok("loop negative bound", loadLoop(direct, -1, zeroSentinel) === zeroSentinel);
ok("loop NaN bound", loadLoop(direct, NaN, zeroSentinel) === zeroSentinel);
ok("loop one iteration", loadLoop(direct, 1, zeroSentinel) === original);
ok("loop fractional bound falls back", loadLoop(direct, 2.5, zeroSentinel) === original);
for (let index = 0; index < 20; index++) {
	ok("loop warm", loadLoop(direct, 10, zeroSentinel) === original);
}
ok("loop one iteration warm", loadLoop(direct, 1, zeroSentinel) === original);

for (let index = 0; index < 2000; index++) {
	ok("direct warm", loadDirect(direct) === original);
	ok("deep warm", loadDeep(deep) === original);
}

holder.method = replacement;
ok("loop invalidation between calls", loadLoop(direct, 10, zeroSentinel) === replacement);
ok("holder replacement", loadDirect(direct) === replacement);
ok("deep holder replacement", loadDeep(deep) === replacement);
for (let index = 0; index < 100; index++) {
	ok("replacement refill", loadDeep(deep) === replacement);
}

middle.method = shadow;
ok("intermediate shadow", loadDeep(deep) === shadow);
delete middle.method;
ok("intermediate unshadow", loadDeep(deep) === replacement);

let getterCalls = 0;
Object.defineProperty(holder, "method", {
	configurable: true,
	get() {
		getterCalls++;
		return replacement;
	},
});
ok("accessor first", loadDirect(direct) === replacement);
ok("accessor second", loadDirect(direct) === replacement && getterCalls === 2);

const alternate = { method: shadow };
Object.setPrototypeOf(middle, alternate);
ok("intermediate reparent", loadDeep(deep) === shadow);

const fourHolder = { method: original };
const four3 = Object.create(fourHolder);
const four2 = Object.create(four3);
const four1 = Object.create(four2);
const fourReceiver = Object.create(four1);
for (let index = 0; index < 100; index++) {
	ok("four-link chain", loadDeep(fourReceiver) === original);
}
fourHolder.method = replacement;
ok("four-link invalidation", loadDeep(fourReceiver) === replacement);

const fiveHolder = { method: original };
const five4 = Object.create(fiveHolder);
const five3 = Object.create(five4);
const five2 = Object.create(five3);
const five1 = Object.create(five2);
const fiveReceiver = Object.create(five1);
for (let index = 0; index < 20; index++) {
	ok("five-link chain", loadDeep(fiveReceiver) === original);
}
fiveHolder.method = replacement;
ok("five-link invalidation", loadDeep(fiveReceiver) === replacement);

const eightHolder = { method: original };
const eight7 = Object.create(eightHolder);
const eight6 = Object.create(eight7);
const eight5 = Object.create(eight6);
const eight4 = Object.create(eight5);
const eight3 = Object.create(eight4);
const eight2 = Object.create(eight3);
const eight1 = Object.create(eight2);
const eightReceiver = Object.create(eight1);
for (let index = 0; index < 100; index++) {
	ok("eight-link chain", loadDeep(eightReceiver) === original);
}
eightHolder.method = replacement;
ok("eight-link invalidation", loadDeep(eightReceiver) === replacement);

const gc = globalThis.__mal_collect_garbage;
function churn(receiver) {
	let result;
	for (let index = 0; index < 10; index++) result = receiver.method;
	return result;
}
for (let pass = 0; pass < 100; pass++) {
	const method = () => pass;
	const proto = { method };
	const receiver = Object.create(proto);
	if (typeof gc === "function") gc();
	ok("GC guarded value", churn(receiver) === method && churn(receiver)() === pass);
}

ok("checks ran", passed > 4300);
console.log("inherited-userland-cache PASS");
