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

// A call that observes one record can return another one through caller storage.
function widen(token, by) {
	let end = token.end;
	for (let step = 0; step < by; step++) end++;
	return { start: token.start, end, digits: token.digits };
}
function widened(text, every) {
	let total = 0;
	let count = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		let span = token.end - token.start;
		if (++count % every === 0) {
			const wide = widen(token, 2);
			span = wide.end - wide.start + wide.digits;
		}
		total += span;
		index = token.end + 1;
	}
	return total;
}

// Returns that hand back other values keep them: undefined still throws on a read,
// and a shared object stays itself.
function terminator(kind, value) {
	for (let guard = 0; guard < 1; guard++) if (kind === "never") throw new Error("never");
	switch (kind) {
		case "jump":
			return { kind, target: value };
		case "branch":
			return { kind, condition: value > 2, target: value + 1 };
		case "return":
			return { kind, value };
	}
}
function targets(kinds) {
	let total = 0;
	for (let index = 0; index < kinds.length; index++) {
		try {
			const input = terminator(kinds[index], index);
			total += (input.target ?? 0) + (input.condition ? 100 : 0) + (input.value ?? 0);
		} catch (error) {
			total += error instanceof TypeError ? 1000 : 1;
		}
	}
	return total;
}
const sharedToken = { start: -1, end: -1, digits: 0 };
function maybeShared(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	if (end - start === 3) return sharedToken;
	return { start, end, digits: 0 };
}
const sharedSeen = [];
function sharedWidths(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		const token = maybeShared(text, index);
		if (token.start < 0) {
			sharedSeen.push(token);
			index += 4;
			continue;
		}
		total += token.end - token.start;
		index = token.end + 1;
	}
	return total;
}

// A callee reads and writes a record its caller keeps; the caller sees the writes.
function stretch(span, by) {
	for (let step = 0; step < by; step++) span.end++;
	return span.end - span.start;
}
function stretched(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		total += stretch(token, 2) + token.end;
		index = token.end - 1;
	}
	return total;
}

// A callee that keeps the record creates its object, which its caller then shares.
const held = [];
function hold(span, keep) {
	let digits = 0;
	for (let step = 0; step < span.digits; step++) digits++;
	if (keep) held.push(span);
	return digits;
}
function holding(text) {
	let total = 0;
	let count = 0;
	for (let index = 0; index < text.length;) {
		const token = scan(text, index);
		total += hold(token, ++count % 5 === 0);
		if (count % 5 === 0) {
			held.push(token);
			token.start = -count;
		}
		index = token.end + 1;
	}
	return total;
}

// One call takes two records, and one instruction observes both.
function between(left, right) {
	let gap = 0;
	for (let index = left.end; index < right.start; index++) gap++;
	return gap + right.digits - left.digits;
}
const pairs = [];
function gaps(text) {
	let total = 0;
	let count = 0;
	for (let index = 0; index < text.length;) {
		const first = scan(text, index);
		const second = scan(text, first.end + 1);
		total += between(first, second);
		if (++count % 4 === 0) pairs.push(first, second);
		index = second.end + 1;
	}
	return total;
}

// A shared object a producer returns reaches the callee as the record itself.
function width(span) {
	let width = 0;
	for (let index = span.start; index < span.end; index++) width++;
	return width;
}
function sharedPassed(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		const token = maybeShared(text, index);
		total += width(token);
		index = token.start < 0 ? index + 4 : token.end + 1;
	}
	return total;
}

// A union record keeps its missing keys absent in the callee.
function decodedWeight(decoded) {
	let weight = decoded.kind.length;
	for (let step = 0; step < 1; step++)
		weight += (decoded.register ?? 0) + (decoded.index ?? 0);
	return weight + (decoded.value === undefined ? 0 : 1000);
}
function decodedWeights(operands) {
	let total = 0;
	for (const operand of operands) total += decodedWeight(decode(operand));
	return total;
}

// A callee can throw after writing to its caller's storage.
function strictWidth(span) {
	span.digits = -span.digits;
	for (let index = span.start; index < span.end; index++)
		if (span.end - span.start > 5) throw new RangeError("wide");
	return span.end - span.start;
}
function readAfterThrow(text, start) {
	const token = scan(text, start);
	const width = strictWidth(token);
	return width * 10 + token.digits;
}
function checkedWidths(text) {
	let total = 0;
	for (let index = 0; index < text.length;) {
		try {
			total += readAfterThrow(text, index);
		} catch (error) {
			total += error instanceof RangeError ? 1000 : 1;
		}
		index = scan(text, index).end + 1;
	}
	return total;
}

// An object literal handed to record parameters stays in its caller's storage.
const contextFailures = [];
function reject(message, context) {
	contextFailures.push(context);
	throw new RangeError(`${message} ${context.index}:${context.opcode}`);
}
const KNOWN_SHAPES = { move: 2, jump: 0 };
function shapeOf(type, context) {
	const shape = KNOWN_SHAPES[type];
	if (shape !== undefined) return shape;
	for (let step = 0; step < 1; step++) if (type === "bad") reject("unknown", context);
	context.opcode = type.toUpperCase();
	return type.length;
}
function shapes(types) {
	let total = 0;
	for (let index = 0; index < types.length; index++) {
		const context = { block: 0, index, opcode: types[index] };
		if (types[index] === "") reject("empty", context);
		total += shapeOf(types[index], context);
		if (context.opcode !== types[index]) total += 100;
	}
	return total;
}
function rejectedShape(types) {
	try {
		return String(shapes(types));
	} catch (error) {
		const context = contextFailures.at(-1);
		return `${error.message}:${context.opcode}:${Object.keys(context).join("+")}`;
	}
}

function lengthOf(span) {
	let length = 0;
	for (let index = span.start; index < span.end; index++) length++;
	return length;
}
function shift(span, by) {
	for (let step = 0; step < by; step++) {
		span.start++;
		span.end += 2;
	}
}
const shiftedSpans = [];
function shiftedLengths(count) {
	let total = 0;
	for (let index = 0; index < count; index++) {
		const span = { start: index, end: index * 2 };
		shift(span, 1);
		total += lengthOf(span) + span.end;
		if (index % 4 === 3) shiftedSpans.push(span);
	}
	return total;
}

// A builtin that coerces a record parameter sees the object and its methods.
let positionCoercions = 0;
function codeAt(text, position) {
	let length = 0;
	for (let index = 0; index < text.length; index++) length++;
	if (length === 0) return -1;
	return text.charCodeAt(position);
}

// One call hands over a record literal and creates another literal's stack object.
const lastOthers = [];
function spanPlus(span, other) {
	lastOthers[0] = other;
	let length = 0;
	for (let index = span.start; index < span.end; index++) length++;
	return length + other.k;
}
function spanSums(count) {
	let total = 0;
	for (let index = 0; index < count; index++) {
		const span = { start: index, end: index + 3 };
		const other = { k: index };
		if (index % 2 === 0) other.k = index * 2;
		total += other.k;
		total += spanPlus(span, other);
	}
	return total;
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
check(widened(text, 3), 517, "observed record into record call");
check(targets(["jump", "branch", "return", "other", "branch"]), 1109, "escaped returns");
check(sharedWidths("ab abc abcd abc a"), 7, "escaped shared object");
check(
	sharedSeen.length === 2 && sharedSeen.every((token) => token === sharedToken),
	true,
	"escaped identity",
);
check(stretched(text), 19880, "record parameter writes");
check(holding(text), 200, "record parameter observer");
check(held.length, 32, "record parameter observer count");
check(held[0] === held[1], true, "record parameter identity");
check(held[0] !== held[2], true, "record parameter freshness");
check(`${held[0].start}:${held[1].end}`, "-5:26", "record parameter object writes");
check(gaps(text), 80, "two record parameters");
check(
	`${pairs.length}:${pairs[0].end}:${pairs[1].start}`,
	"20:38:39",
	"two observed records",
);
check(sharedPassed("ab abc abcd abc a"), 7, "shared object as record parameter");
check(decodedWeights([4, -1, -2, -3, 0]), 1045, "union record parameter");
check(checkedWidths(text), 41140, "record parameter throws");
check(
	rejectedShape(["move", "jump", "add", "move"]),
	"107",
	"literal record parameter writes",
);
check(
	rejectedShape(["move", "bad"]),
	"unknown 1:bad:bad:block+index+opcode",
	"literal record parameter observer",
);
check(contextFailures.length, 1, "literal record parameter observer count");
check(shiftedLengths(16), 408, "literal handed to two record parameters");
check(
	`${shiftedSpans.length}:${shiftedSpans[0].start}:${shiftedSpans[0].end}:${shiftedSpans[0] !== shiftedSpans[1]}`,
	"4:4:8:true",
	"literal record parameter identity",
);
check(
	codeAt("x12", {
		valueOf() {
			positionCoercions++;
			return 1;
		},
	}),
	49,
	"record parameter coerced by a builtin",
);
check(positionCoercions, 1, "record parameter coercions");
check(spanSums(10), 160, "record literal beside a stack object");
check(lastOthers[0].k, 9, "stack object beside a record literal");
const handlers = attach(["a", "try-b", "cc", "try-dd", "e", "f", "try-g"], []);
check(
	handlers.map((environment) => `${environment.state}@${environment.version}`).join(","),
	"try-b@10,try-dd@24,try-g@10",
	"handed-on records",
);
console.log("record-result-entries PASS");
