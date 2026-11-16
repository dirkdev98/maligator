function check(condition, message) {
	if (!condition) throw new Error(message);
}
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const payload = { label: "forwarded snapshot" };
const ignored = { label: "caller input" };
function take(value) {
	if (typeof gc === "function") gc();
	return value;
}
async function spread(ownInput, forwarded = payload) {
	function forward(...values) {
		return take(...values);
	}
	let result;
	for (let index = 0; index < 10; index++) result = forward(forwarded);
	return result;
}
async function apply(ownInput, forwarded = payload) {
	function forward(fn, ...values) {
		return fn.apply(null, values);
	}
	let result;
	for (let index = 0; index < 10; index++) result = forward(take, forwarded);
	return result;
}
for (const invoke of [spread, apply]) {
	check((await invoke()) === payload, "zero-argument caller forwards its snapshots");
	check((await invoke(ignored)) === payload, "caller inputs do not replace snapshots");
	const result = await invoke(ignored, { label: "local snapshot" });
	check(
		result.label === "local snapshot",
		"positional snapshots keep temporary values rooted",
	);
}
let exposed;
take.apply = function (receiver, values) {
	exposed = values;
	return values[0];
};
check((await apply(ignored)) === payload, "overridden apply receives the helper input");
check(
	Array.isArray(exposed) && exposed[0] === payload,
	"fallback exposes a real rest list",
);
delete take.apply;
const changed = { label: "iterator input" };
const iterator = Array.prototype[Symbol.iterator];
try {
	Array.prototype[Symbol.iterator] = function* () {
		yield changed;
	};
	check((await spread(ignored)) === changed, "spread observes a replaced iterator");
} finally {
	Array.prototype[Symbol.iterator] = iterator;
}
function reject(value) {
	throw value;
}
async function rejecting(ownInput) {
	function forward(fn, ...values) {
		return fn(...values);
	}
	for (let index = 0; index < 10; index++) forward(reject, payload);
}
try {
	await rejecting(ignored);
	throw new Error("missing rejection");
} catch (error) {
	check(error === payload, "forwarded throws reject with their original value");
}
const thenable = {
	then(resolve) {
		check(this === thenable, "thenable receiver");
		resolve(payload);
	},
};
async function adopting(ownInput) {
	function forward(...values) {
		return take(...values);
	}
	let result;
	for (let index = 0; index < 10; index++) result = forward(thenable);
	return result;
}
check((await adopting(ignored)) === payload, "return adopts the forwarded thenable");
console.log("rest-forwarding-immediate PASS");
