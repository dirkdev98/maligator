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

// A record that only a rare branch hands on needs no object on the common path.
function environmentOf(states, index) {
	let version = 0;
	for (let step = 0; step <= index % 5; step++) version += states[index].length;
	return { state: states[index], version };
}
function attach(states, handlers) {
	for (let index = 0; index < states.length; index++) {
		const environment = environmentOf(states, index);
		if (states[index].startsWith("try")) handlers.push(environment);
	}
	return handlers;
}

// A forwarder returns either its own literal or the record of another producer.
function nextWord(text, start) {
	let index = start;
	while (index < text.length && text.charCodeAt(index) === 32) index++;
	if (index >= text.length) return { start: index, end: index, digits: 0 };
	return scan(text, index);
}
function wordWidths(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		const word = nextWord(text, index);
		total += word.end - word.start + word.digits;
		index = word.end + 1;
	}
	return total;
}

// Only forwarding reaches this producer, so its forwarder copies the returned literal.
function trailing(text, start) {
	let end = text.length;
	while (end > start && text.charCodeAt(end - 1) === 32) end--;
	return { start, end, digits: end - start };
}
function trimmed(text, start) {
	let index = start;
	while (index < text.length && text.charCodeAt(index) === 32) index++;
	return trailing(text, index);
}
function trimmedWidth(text) {
	const span = trimmed(text, 0);
	return `${span.start}:${span.end}:${span.digits}`;
}

// Literals with different keys: a missing key reads as undefined, as no prototype has it.
function decode(operand) {
	for (let guard = 0; guard < 1; guard++)
		if (operand === -1000) throw new Error("bad operand");
	if (operand >= 0) return { kind: "register", register: operand };
	switch (operand) {
		case -1:
			return { kind: "undefined" };
		case -2:
			return { value: false, kind: "boolean" };
	}
	return { kind: "string", index: -operand };
}
const decodedSeen = [];
function decodeAll(operands) {
	let summary = "";
	for (const operand of operands) {
		const decoded = decode(operand);
		if (decoded.kind === "boolean") decoded.kind = "flag";
		summary += `${decoded.kind[0]}${decoded.register ?? ""}${decoded.index ?? ""}${decoded.value === undefined ? "" : "v"};`;
		if (operand === -3) decodedSeen.push(decoded);
		if (operand === -1) {
			decoded.register = 7;
			decodedSeen.push(decoded);
		}
	}
	return summary;
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
check(wordWidths(`  ${text}   `), 600, "forwarded records");
check(trimmedWidth("   padded value  "), "3:15:12", "copied forwarded records");
check(decodeAll([4, -1, -2, -3, 0]), "r4;u;fv;s3;r0;", "union records");
check(
	decodedSeen.map((record) => Object.keys(record).join("+")).join(","),
	"kind+register,kind+index",
	"union shapes",
);
check(decodedSeen[0].register, 7, "union store");
const handlers = attach(["a", "try-b", "cc", "try-dd", "e", "f", "try-g"], []);
check(
	handlers.map((environment) => `${environment.state}@${environment.version}`).join(","),
	"try-b@10,try-dd@24,try-g@10",
	"handed-on records",
);
console.log("record-result-entries PASS");
