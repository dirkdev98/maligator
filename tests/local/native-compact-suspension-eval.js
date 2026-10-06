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
