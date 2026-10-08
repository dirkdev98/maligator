const gc = globalThis.__mal_collect_garbage ?? (() => {});

function* compactArguments(first, ...rest) {
	let captured = first;
	const read = () => captured;
	yield read;
	captured += arguments[1];
	yield eval("captured");
	return [read(), rest.length, this.label];
}
const compactArgumentIterator = compactArguments.call({ label: "receiver" }, 3, 5, 7);
const compactReadCapture = compactArgumentIterator.next().value;
gc();
console.log(
	"compact-arguments",
	compactReadCapture(),
	compactArgumentIterator.next().value,
);
const compactSpliced = eval("(function compactSpliced() { return 42; })");
gc();
console.log(
	"compact-captures",
	JSON.stringify(compactArgumentIterator.next().value),
	compactReadCapture(),
);
gc();
console.log("compact-eval", compactSpliced());

function* immortalLiteralAcrossEval() {
	const text = "'caf\u00e9'";
	yield text;
	const result = eval(text);
	gc();
	yield result;
	return text;
}
const literalIterator = immortalLiteralAcrossEval();
const literalSource = literalIterator.next().value;
gc();
const literalResult = literalIterator.next().value;
eval("(function anotherLiteralSplice() { return 'new pool entry'; })");
gc();
const literalRestored = literalIterator.next();
if (
	literalResult !== "caf\u00e9" ||
	literalRestored.value !== literalSource ||
	!literalRestored.done
)
	throw new Error("immutable literal changed across widening, collection or eval splice");
console.log("compact-immutable-literal", literalResult, literalRestored.done);

async function immortalLiteralAcrossAwait(gate) {
	const text = "caf\u00e9";
	await gate;
	gc();
	return text;
}
let releaseLiteral;
const literalGate = new Promise((resolve) => {
	releaseLiteral = resolve;
});
const literalPromise = immortalLiteralAcrossAwait(literalGate);
eval("(function pendingLiteralSplice() { return 'another pool entry'; })");
gc();
releaseLiteral();
literalPromise.then((text) => {
	if (text !== "caf\u00e9")
		throw new Error("immutable literal changed across await or eval splice");
	console.log("compact-immutable-await", text);
});

function* immortalBigIntAcrossEval() {
	const value = 123456789012345678901234567890n;
	yield value;
	eval("(function bigintPoolSplice() { return 9876543210987654321n; })");
	gc();
	return value;
}
const bigintIterator = immortalBigIntAcrossEval();
const bigintLiteral = bigintIterator.next().value;
gc();
const bigintRestored = bigintIterator.next();
if (!bigintRestored.done || bigintRestored.value !== bigintLiteral)
	throw new Error(
		"immutable BigInt changed across suspension, collection or eval splice",
	);
console.log("compact-immutable-bigint", String(bigintRestored.value));
