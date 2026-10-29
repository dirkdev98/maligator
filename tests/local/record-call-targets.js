function check(actual, expected) {
	if (!Object.is(actual, expected)) throw new Error("record call target mismatch");
}
const collect = globalThis.__mal_collect_garbage;
let visits = 0;
function visit() {
	visits++;
	if (typeof collect === "function") collect();
}
const make = function make(depth, offset, observe) {
	if (depth > 0) return make(depth - 1, offset, observe);
	for (let i = 0; i < 3; i++) observe();
	const state = { offset };
	return {
		callback: function producedField(value) {
			for (let i = 0; i < 3; i++) observe();
			return state.offset + value;
		},
	};
};
const forward = function forward(depth, offset, observe) {
	for (let i = 0; i < 3; i++) observe();
	return make(depth, offset, observe);
};
function invokeRecord(depth, offset, observe, value) {
	const callback = forward(depth, offset, observe).callback;
	return typeof callback === "function" ? callback(value) : -1;
}
check(invokeRecord(2, 10, visit, 32), 42);
check(invokeRecord(0, 20, visit, 22), 42);
check(visits, 18);
const first = forward(1, 10, visit),
	second = forward(0, 20, visit);
const saved = first.callback;
first.callback = second.callback;
check(first.callback(2), 22);
check(saved(1), 11);
function overwrite(flag) {
	const record = forward(1, 40, visit);
	if (flag) record.callback = (value) => value * 2;
	return record.callback(2);
}
check(overwrite(false), 42);
check(overwrite(true), 4);

function* loadedBeforeSuspend() {
	const callback = forward(1, 40, visit).callback;
	yield 0;
	return typeof callback === "function" ? callback(2) : -1;
}
const loaded = loadedBeforeSuspend();
loaded.next();
visit();
check(loaded.next().value, 42);
function* recordBeforeSuspend() {
	const record = forward(1, 40, visit);
	yield record;
	return typeof record.callback === "function" ? record.callback(2) : -1;
}
const exposed = recordBeforeSuspend();
exposed.next().value.callback = 17;
visit();
check(exposed.next().value, -1);

const makeProxy = function makeProxy(callback) {
	for (let i = 0; i < 3; i++) visit();
	return { callback };
};
let traps = 0;
const callable = new Proxy(() => 11, {
	apply(target, receiver, args) {
		traps++;
		visit();
		return args[0] + 1;
	},
});
check(makeProxy(callable).callback(41), 42);
check(traps, 1);
const revoked = Proxy.revocable(() => 11, {});
revoked.revoke();
check(typeof makeProxy(revoked.proxy).callback, "function");
try {
	makeProxy(revoked.proxy).callback();
	throw new Error("missing revoked call error");
} catch (error) {
	check(error instanceof TypeError, true);
}
let reads = 0;
const getter = function getter() {
	return {
		get callback() {
			reads++;
			visit();
			return reads === 1 ? callable : 17;
		},
	};
};
check(getter().callback(41), 42);
check(typeof getter().callback, "number");
check(reads, 2);
const escaped = function escaped(observe) {
	const record = { callback: callable };
	observe(record);
	return record;
};
check(typeof escaped((record) => (record.callback = 17)).callback, "number");
const classFactory = function classFactory() {
	for (let i = 0; i < 3; i++) visit();
	return { callback: class RecordClass {} };
};
const Constructor = classFactory().callback;
check(new Constructor() instanceof Constructor, true);
try {
	Constructor();
	throw new Error("missing class call error");
} catch (error) {
	check(error instanceof TypeError, true);
}
Object.assign(globalThis, { invokeRecord, loadedBeforeSuspend, recordBeforeSuspend });
console.log("record-call-targets PASS");
