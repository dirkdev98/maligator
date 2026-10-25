function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof collect !== "function") throw new Error("Missing collector");

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

function factFamily(initial) {
	let value = initial;
	const read = () => value;
	function writeNumeric(next, flag, callback) {
		const selected = flag ? +next : null;
		callback();
		value = selected;
		collect();
		return read();
	}
	function writeBoolean(next, flag) {
		value = flag ? !!next : undefined;
		collect();
		return read();
	}
	function writeSelected(next, flag) {
		value = flag ? next : null;
		collect();
		return read();
	}
	globalThis.selectedCaptureWriter = writeSelected;
	writeSelected(+globalThis.captureInput, true);
	return { read, writeNumeric, writeBoolean, writeSelected };
}

const facts = factFamily({ marker: "initial" });
for (const value of [0, -0, NaN, Infinity, -Infinity, 1.5]) {
	check(
		"nullable numeric capture",
		Object.is(facts.writeNumeric(value, true, collect), value),
		true,
	);
	check("nullable null capture", facts.writeNumeric(value, false, collect), null);
	check("boxed Boolean capture", facts.writeBoolean(value, true), !!value);
	check("boxed undefined capture", facts.writeBoolean(value, false), undefined);
}
let coercions = 0;
try {
	facts.writeNumeric(
		{
			valueOf() {
				coercions++;
				facts.writeSelected({ marker: "reentry" }, true);
				throw coercionFailure;
			},
		},
		true,
		collect,
	);
	throw new Error("Coercion did not throw");
} catch (error) {
	check("numeric store preserves coercion error", error, coercionFailure);
}
check("numeric coercion runs once", coercions, 1);
check("throwing numeric store preserves reentry", facts.read().marker, "reentry");
try {
	facts.writeNumeric(42, true, () => {
		facts.writeSelected("callback replacement", true);
		throw coercionFailure;
	});
	throw new Error("Callback did not throw");
} catch (error) {
	check("numeric store preserves callback error", error, coercionFailure);
}
check("throwing callback prevents scalar store", facts.read(), "callback replacement");
for (const value of [
	"heap-backed string " + globalThis.captureInput,
	Symbol("heap symbol"),
	123456789012345678901234567890n,
	{ marker: "heap" },
]) {
	facts.writeSelected(value, true);
	collect();
	check("heap fallback after scalar stores", facts.read(), value);
}

const iterations = [];
for (let i = 0; i < 6; i++) {
	let value = { marker: i };
	const read = () => value;
	iterations.push(read);
	collect();
	value = i & 1 ? +i : null;
	collect();
	check("per-iteration non-heap store", read(), i & 1 ? i : null);
}
for (let i = 0; i < iterations.length; i++)
	check("per-iteration owner identity", iterations[i](), i & 1 ? i : null);
console.log("closure-capture-stores PASS");
