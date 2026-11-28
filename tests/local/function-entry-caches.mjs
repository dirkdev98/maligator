function throughElidedClosure(record) {
	let remaining = 3;
	function elided() {
		if (--remaining > 0) return elided();
		const result = { payload: record.value * 3 };
		return record.preserve ? record : result;
	}
	return elided();
}

function makeReader(offset) {
	return function read(record) {
		record.value += offset;
		return { payload: record.value };
	};
}

const readerKey = process.env.MAL_TEST_READER_KEY ?? "reader";

function invoke(reader, record) {
	const callbacks = {};
	Reflect.set(callbacks, readerKey, reader);
	return Reflect.apply(Reflect.get(callbacks, readerKey), null, [record]).payload;
}

function* suspendedRead(record) {
	yield record.value;
	return { payload: record.value };
}

const record = JSON.parse('{"value":4}');
const reader = makeReader(2);
const otherReader = makeReader(3);
const initial = throughElidedClosure(record).payload;
const first = invoke(reader, record);
const second = invoke(otherReader, record);
const typed = makeReader(0)(record).payload;
const generator = suspendedRead(record);
const yielded = generator.next().value;
record.value += 1;
console.log(initial, first, second, typed, yielded, generator.next().value.payload);
