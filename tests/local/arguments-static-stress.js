function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function repeatedSnapshots() {
	const first = arguments[0] === undefined ? 7 : arguments[0];
	const fifth = arguments[4] === undefined ? 3 : arguments[4];
	return (
		arguments.length * 1000 +
		arguments.length * 100 +
		first * 10 +
		(arguments[0] === undefined ? 0 : arguments[0]) +
		fifth
	);
}

function lexicalArrow(value) {
	return () => arguments[0] + value;
}

function* retainedGenerator() {
	yield arguments[0];
	yield arguments.length;
}

async function retainedAsync() {
	const first = arguments[0];
	await 0;
	return first + arguments.length;
}

assert(repeatedSnapshots() === 73, "omitted repeated snapshots");
assert(repeatedSnapshots(2, 3, 4, 5, 6) === 5528, "wide repeated snapshots");
assert(lexicalArrow(2)(5) === 4, "lexical arrow lifetime");

const retained = { retained: true };
const iterator = retainedGenerator(retained, 2);
assert(iterator.next().value === retained, "generator argument lifetime");
assert(iterator.next().value === 2, "generator count lifetime");

retainedAsync(7, 8).then((value) => {
	assert(value === 9, "async arguments lifetime");
	console.log("arguments-static-stress PASS");
});
