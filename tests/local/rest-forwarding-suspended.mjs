function check(condition, message) {
	if (!condition) throw new Error(message);
}
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function churn() {
	for (let i = 0; i < 12; i++) {
		const value = { child: { i } };
		check(value.child.i === i, "churn");
	}
	if (typeof gc === "function") gc();
}
function take(value) {
	churn();
	return value;
}
const payload = { label: "suspended input" };
async function asyncForward(first, ...values) {
	first = null;
	await 0;
	const result = take(...values);
	await 0;
	return take(...values) === result ? result : null;
}
function* generatorForward(first, ...values) {
	first = null;
	yield 1;
	const result = take(...values);
	yield 2;
	return take(...values) === result ? result : null;
}
async function* asyncGeneratorForward(...values) {
	await 0;
	yield 1;
	await 0;
	return take(...values);
}
check((await asyncForward(0, payload)) === payload, "async retained inputs");
const generator = generatorForward(0, payload);
check(
	generator.next().value === 1 &&
		generator.next().value === 2 &&
		generator.next().value === payload,
	"generator retained inputs",
);
const asyncGenerator = asyncGeneratorForward(payload);
check(
	(await asyncGenerator.next()).value === 1 &&
		(await asyncGenerator.next()).value === payload,
	"async generator retained inputs",
);
function initialize(depth = 12) {
	if (depth > 0) return initialize(depth - 1);
	churn();
	return null;
}
function* defaultForward(first = initialize(), ...values) {
	yield 1;
	return take(...values);
}
const defaults = defaultForward(undefined, payload);
churn();
check(
	defaults.next().value === 1 && defaults.next().value === payload,
	"reentrant parameter defaults retain extra arguments",
);
async function unmappedForward(first) {
	first = null;
	await 0;
	return take.apply(null, arguments);
}
check((await unmappedForward(payload)) === payload, "suspended unmapped arguments");
let exposed;
function echo(value) {
	return value;
}
function expose(receiver, values) {
	exposed = values;
	return values[0];
}
let release;
const gate = new Promise((resolve) => {
	release = resolve;
});
async function asyncFallback(fn, ...values) {
	const first = fn.apply(null, values);
	await gate;
	return [first, fn.apply(null, values)];
}
const changed = { label: "changed while suspended" };
echo.apply = expose;
const pending = asyncFallback(echo, payload);
check(Array.isArray(exposed), "async fallback materializes an Array");
exposed[0] = changed;
exposed = undefined;
delete echo.apply;
churn();
release();
const completed = await pending;
check(
	completed[0] === payload && completed[1] === changed,
	"async fallback state remains authoritative after protocol recovery",
);
function* generatorFallback(fn, ...values) {
	yield fn.apply(null, values);
	return fn.apply(null, values);
}
echo.apply = expose;
const fallback = generatorFallback(echo, payload);
check(fallback.next().value === payload, "generator fallback before suspension");
exposed[0] = changed;
exposed = undefined;
delete echo.apply;
churn();
check(fallback.next().value === changed, "generator fallback state survives suspension");
let exposedArguments;
function argumentTarget(fn, value) {
	return value;
}
argumentTarget.apply = function (receiver, values) {
	let poisoned = false;
	try {
		values.callee;
	} catch (error) {
		poisoned = error instanceof TypeError;
	}
	check(poisoned, "suspended arguments retain callee poison");
	exposedArguments = values;
	return values[1];
};
async function argumentsFallback(fn, value) {
	fn.apply(null, arguments);
	await 0;
	return fn.apply(null, arguments);
}
const argumentsPending = argumentsFallback(argumentTarget, payload);
exposedArguments[1] = changed;
exposedArguments = undefined;
delete argumentTarget.apply;
churn();
check(
	(await argumentsPending) === changed,
	"unmapped fallback state survives suspension",
);
let finalized;
function* finallyForward(...values) {
	try {
		yield 1;
	} finally {
		finalized = take(...values);
	}
}
const returning = finallyForward(payload);
returning.next();
check(
	returning.return(17).value === 17 && finalized === payload,
	"return resumes forwarding finally",
);
const throwing = finallyForward(changed);
throwing.next();
try {
	throwing.throw(payload);
	throw new Error("missing throw");
} catch (error) {
	check(error === payload && finalized === changed, "throw resumes forwarding finally");
}
async function rejectedForward(reason, ...values) {
	try {
		await Promise.reject(reason);
	} finally {
		finalized = take(...values);
	}
}
try {
	await rejectedForward(payload, changed);
	throw new Error("missing rejection");
} catch (error) {
	check(
		error === payload && finalized === changed,
		"rejection resumes forwarding finally",
	);
}
for (let i = 0; i < 12; i++) generatorForward(0, { i }).next();
churn();

async function resumedSpread(ignored, value) {
	function forward(...values) {
		return take(...values);
	}
	await 0;
	let result;
	for (let index = 0; index < 10; index++) result = forward(value);
	await 0;
	return result;
}
async function resumedArguments(ignored, value) {
	function forward() {
		"use strict";
		return take.apply(null, arguments);
	}
	await 0;
	let result;
	for (let index = 0; index < 10; index++) result = forward(value);
	await 0;
	return result;
}
check((await resumedSpread(17, payload)) === payload, "resumed spread snapshots");
check((await resumedArguments(17, payload)) === payload, "resumed arguments snapshots");
check(
	(await resumedSpread(17, { label: "temporary resumed snapshot" })).label ===
		"temporary resumed snapshot",
	"resumed snapshots root temporary objects",
);
take.apply = expose;
check((await resumedArguments(17, payload)) === payload, "resumed arguments fallback");
check(
	Object.prototype.toString.call(exposed) === "[object Arguments]",
	"inlined arguments fallback retains its brand",
);
let poison = false;
try {
	exposed.callee;
} catch (error) {
	poison = error instanceof TypeError;
}
check(poison, "inlined arguments fallback retains callee poison");
delete take.apply;
exposed = undefined;

function* resumedApply(ignored, value) {
	function forward(fn, ...values) {
		return fn.apply(null, values);
	}
	yield forward(take, value);
	churn();
	return forward(take, value);
}
take.apply = expose;
const resumed = resumedApply(17, payload);
check(resumed.next().value === payload, "generator-entry snapshots");
check(Array.isArray(exposed), "inlined apply exposes a rest Array");
exposed[0] = changed;
exposed = undefined;
delete take.apply;
churn();
check(resumed.next().value === payload, "resumed helper starts with a fresh rest state");

async function* resumedAsyncGenerator(ignored, value) {
	function forward(...values) {
		return take(...values);
	}
	await 0;
	yield forward(value);
	await 0;
	return forward(value);
}
const resumedAsync = resumedAsyncGenerator(17, payload);
check(
	(await resumedAsync.next()).value === payload &&
		(await resumedAsync.next()).value === payload,
	"async generator snapshots across await and yield",
);

function* resumedFinally(ignored, value) {
	function forward(...values) {
		return take(...values);
	}
	try {
		yield 0;
	} finally {
		finalized = forward(value);
	}
}
const returningInline = resumedFinally(17, payload);
returningInline.next();
check(
	returningInline.return(23).value === 23 && finalized === payload,
	"return executes inlined forwarding in finally",
);
const throwingInline = resumedFinally(17, changed);
throwingInline.next();
try {
	throwingInline.throw(payload);
	throw new Error("missing inline throw");
} catch (error) {
	check(
		error === payload && finalized === changed,
		"throw executes inlined forwarding in finally",
	);
}
console.log("rest-forwarding-suspended PASS");
