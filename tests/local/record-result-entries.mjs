function check(actual, expected, label) {
	if (!Object.is(actual, expected))
		throw new Error(`record result ${label}: ${String(actual)} != ${String(expected)}`);
}

// A loop keeps the producer out of line, so its callers receive fields through a call.
function scan(text, start) {
	let end = start;
	let digits = 0;
	while (end < text.length && text.charCodeAt(end) !== 32) {
		const code = text.charCodeAt(end);
		if (code >= 48 && code <= 57) digits++;
		end++;
	}
	return { start, end, digits };
}

function tokenLengths(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		total += token.end - token.start + token.digits;
		index = token.end + 1;
	}
	return total;
}

function digitCount(text) {
	let digits = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		digits += token.digits;
		index = token.end + 1;
	}
	return digits;
}

// Heap-valued fields must stay alive across allocations between the call and the reads.
function describe(words, index) {
	let longest = "";
	for (const word of words) if (word.length > longest.length) longest = word;
	if (index < 0) throw new RangeError(`negative index ${index}`);
	return {
		word: words[index % words.length] + "!",
		longest,
		parts: [index, longest.length],
	};
}

function describeAll(words, count) {
	let text = "";
	for (let index = 0; index < count; index++) {
		const description = describe(words, index);
		const filler = [];
		for (let step = 0; step < 32; step++) filler.push({ step, label: `filler-${step}` });
		text += description.word + description.longest + description.parts[1] + filler.length;
	}
	return text.length;
}

// Every return site builds the same keys in the same order.
function classify(value) {
	let steps = 0;
	for (
		let current = value;
		current > 1;
		current = current % 2 === 0 ? current / 2 : 3 * current + 1
	)
		steps++;
	if (steps === 0) return { kind: "trivial", steps, value };
	if (steps % 2 === 0) return { kind: "even", steps, value };
	return { kind: "odd", steps, value: value * 2 };
}

function classifyAll(limit) {
	let summary = "";
	let total = 0;
	for (let value = 1; value <= limit; value++) {
		const result = classify(value);
		summary += result.kind[0];
		total += result.steps + result.value;
	}
	return `${summary.length}:${summary.slice(0, 12)}:${total}`;
}

// A throw after the record's initializers ran must not leak fields into the caller.
function guarded(words, index) {
	let seen = 0;
	try {
		const description = describe(words, index);
		seen = description.parts[0];
		return `${description.word}/${seen}`;
	} catch (error) {
		return `${error.name}/${seen}`;
	}
}

// Callers that keep the object still receive a fresh, distinct record from every call.
function retainAll(text) {
	const tokens = [];
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		tokens.push(token);
		index = token.end + 1;
	}
	return tokens;
}

// A record producer that consumes its own records through a recursive call.
function depth(tree) {
	let size = 1;
	let deepest = 0;
	for (let index = 0; index < tree.length; index++) {
		const child = depth(tree[index]);
		size += child.size;
		if (child.deepest + 1 > deepest) deepest = child.deepest + 1;
	}
	return { size, deepest };
}

function discard(text) {
	let calls = 0;
	for (let index = 0; index < text.length; index += 3) {
		scan(text, index);
		calls++;
	}
	return calls;
}

// Observers on rare paths need the object; later reads must see what they did to it.
const kept = [];
function bump(token) {
	token.end += 1000;
}
function observed(text, every) {
	let total = 0;
	let count = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		token.digits *= 2;
		count++;
		if (count % every === 0) {
			kept.push(token);
			kept.push(token);
			bump(token);
		}
		total += token.end - token.start + token.digits;
		index = (token.end % 1000) + 1;
	}
	return total;
}

function found(text, digits) {
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		if (token.digits === digits) return token;
		index = token.end + 1;
	}
	return undefined;
}

function rejected(text) {
	try {
		for (let index = 0; index < text.length;) {
			const token = scan(text, index);
			if (token.digits > 2) throw token;
			index = token.end + 1;
		}
	} catch (error) {
		return `${Object.keys(error).join(",")}:${error.start}:${error.digits}`;
	}
	return "none";
}

const text = "a1 bb22 ccc333 dddd4444 ".repeat(20);
check(tokenLengths(text), 600, "token lengths");
check(digitCount(text), 200, "digit count");
check(describeAll(["alpha", "beta", "gamma", "delta"], 40), 550, "heap fields");
check(classifyAll(60), "60:tooeoeeooeeo:4129", "multiple returns");
check(guarded(["x"], 2), "x!/2", "guarded success");
check(guarded(["x"], -1), "RangeError/0", "guarded throw");
const tokens = retainAll("ab cd ab");
check(tokens.length, 3, "retained count");
check(tokens[0] === tokens[2], false, "fresh identity");
check(tokens[0].end, 2, "retained field");
tokens[1].end = 99;
check(tokens[1].end, 99, "retained mutation");
check(Object.keys(tokens[2]).join(","), "start,end,digits", "retained shape");
const tree = [[[], [[]]], [], [[[[]]]]];
const measured = depth(tree);
check(`${measured.size}:${measured.deepest}`, "10:4", "recursive records");
check(discard(text), 160, "discarded records");
check(observed(text, 7), 11800, "observed records");
check(kept.length, 22, "observed count");
check(kept[0] === kept[1], true, "observed identity");
check(kept[0] !== kept[2], true, "observed freshness");
check(`${kept[0].end}:${kept[0].digits}`, "1038:6", "observed mutation");
check(Object.getPrototypeOf(kept[3]) === Object.prototype, true, "observed prototype");
const result = found(text, 3);
check(`${result?.start}:${result?.end}`, "8:14", "returned observer");
check(found(text, 9), undefined, "missing observer");
check(rejected(text), "start,end,digits:8:3", "thrown observer");
console.log("record-result-entries PASS");
