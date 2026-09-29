function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

function makeFamily(initial) {
	let value = initial;
	return {
		read: () => value,
		write: (next) => (value = next),
		nested: () => () => value,
	};
}

// Repeated replacement must not let the primitive fast path hide later heap edges.
const changingState = makeFamily(0);
const changingReader = changingState.nested();
for (let i = 0; i < 96; i++) {
	changingState.write({ index: i, text: "captured heap-backed text " + i });
	for (let j = 0; j < 24; j++) {
		const temporary = makeFamily({ index: j });
		check("changing capture allocation pressure", temporary.read().index, j);
	}
	check("young object survives through shared cell", changingReader().index, i);
	check(
		"object payload survives through shared cell",
		changingReader().text,
		"captured heap-backed text " + i,
	);
	changingState.write(-0);
	check("captured negative zero", 1 / changingReader(), -Infinity);
	changingState.write(NaN);
	const notANumber = changingReader();
	check("captured NaN", notANumber !== notANumber, true);
	changingState.write(false);
	check("captured boolean", changingReader(), false);
	changingState.write(null);
	check("captured null", changingReader(), null);
	changingState.write(undefined);
	check("captured undefined", changingReader(), undefined);
	changingState.write("replacement heap-backed string " + i);
	check(
		"captured string after primitive stores",
		changingReader(),
		"replacement heap-backed string " + i,
	);
}

const coercionFailure = new Error("capture coercion failure");
changingState.write({
	valueOf() {
		changingState.write({ index: 777 });
		throw coercionFailure;
	},
});
let sawCoercionFailure = false;
try {
	changingState.write(changingReader() + 1);
} catch (error) {
	sawCoercionFailure = error === coercionFailure;
}
check("capture coercion preserves throw identity", sawCoercionFailure, true);
check("throwing coercion preserves reentrant replacement", changingReader().index, 777);
console.log("closure-capture-stores PASS");
