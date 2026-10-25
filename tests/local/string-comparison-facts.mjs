const results = [];

function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}

function joined(value, flag) {
	const literal = flag ? "ready" : "other";
	return value === literal;
}

function copied(value, flag) {
	let literal = "ready";
	if (flag) literal = "other";
	const alias = literal;
	return value !== alias;
}

function exactString(value, flag) {
	const text = String(value);
	const literal = flag ? "ready" : "other";
	collect();
	return text === literal;
}

function differentLength(value, flag) {
	const literal = flag ? "ready" : "wide";
	return value === literal;
}

function unicode(value, flag) {
	const literal = flag ? "𝌆é" : "aßc";
	return value === literal;
}

function empty(value, flag) {
	const literal = flag ? "" : "";
	return value !== literal;
}

function handler(value, flag) {
	const literal = flag ? "ready" : "other";
	try {
		if (flag) throw new Error();
		return value === literal;
	} catch {
		collect();
		return value === literal;
	}
}

function repeated(value, flag, count) {
	let literal = "ready";
	let matches = 0;
	for (let i = 0; i < count; i++) {
		if (value === literal) matches++;
		literal = flag ? "other" : "ready";
	}
	return matches;
}

function* suspended(value, flag) {
	const literal = flag ? "ready" : "other";
	yield literal;
	collect();
	return value === literal;
}

async function asynchronous(value, flag) {
	const literal = flag ? "ready" : "other";
	await 0;
	collect();
	return value !== literal;
}

Object.assign(globalThis, {
	joined,
	copied,
	exactString,
	differentLength,
	unicode,
	empty,
	handler,
	repeated,
	suspended,
	asynchronous,
});

async function main() {
	for (const value of [
		"ready",
		"other",
		"wide",
		"",
		"reádý",
		"𝌆é",
		"aßc",
		"ab\0cd",
		"x".repeat(2048),
		undefined,
		null,
		5,
		true,
		17n,
		Symbol.for("ready"),
		{
			[Symbol.toPrimitive]() {
				collect();
				return "ready";
			},
		},
	]) {
		for (const flag of [false, true]) {
			for (const fn of [
				joined,
				copied,
				exactString,
				differentLength,
				unicode,
				empty,
				handler,
			])
				results.push(fn(value, flag));
			results.push(repeated(value, flag, 3));
			const iterator = suspended(value, flag);
			results.push(iterator.next().value);
			collect();
			results.push(iterator.next().value);
			results.push(await asynchronous(value, flag));
		}
	}
	console.log(results.join("|"));
}

main();
