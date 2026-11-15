const collectGarbage = globalThis.__mal_collect_garbage;
const iterations = 64;
JSON.parse('{"first":0,"second":1}');
JSON.parse('{"left":2,"right":3}');
const retained = [];
for (let index = 0; index < iterations; index++) {
	const first = JSON.parse(`{"first":${index},"second":${index + 1}}`);
	const second = JSON.parse(`{"left":${index + 2},"right":${index + 3}}`);
	collectGarbage();
	if (
		first.first !== index ||
		first.second !== index + 1 ||
		second.left !== index + 2 ||
		second.right !== index + 3 ||
		Object.keys(first).join(",") !== "first,second" ||
		Object.keys(second).join(",") !== "left,right"
	)
		throw new Error("parsed record lost its keys or values");
	if (index === 0) retained.push(first, second);
}
collectGarbage();
if (retained[0].first !== 0 || retained[1].left !== 2)
	throw new Error("later records changed a retained object");

const documents = [
	['{"first":1,"second":2,"first":3}', '{"first":3,"second":2}'],
	['{"first":1}', '{"first":1}'],
	['{"first":1,"other":2}', '{"first":1,"other":2}'],
	['{"first":1,"second":2,"third":3}', '{"first":1,"second":2,"third":3}'],
	[
		'{"first":1,"second":{"left":2,"right":3},"third":4}',
		'{"first":1,"second":{"left":2,"right":3},"third":4}',
	],
	['{"café":1,"日本":2}', '{"café":1,"日本":2}'],
];
for (const [text, expected] of documents) {
	for (let repeat = 0; repeat < 4; repeat++) {
		if (JSON.stringify(JSON.parse(text)) !== expected)
			throw new Error("record prediction changed key order or values");
	}
}

for (const name of ['q"uote', "line\nkey", "slash\\key"]) {
	const valid = JSON.stringify({ first: 1, [name]: 2 });
	for (let repeat = 0; repeat < 4; repeat++) JSON.parse(valid);
	let rejected = false;
	try {
		JSON.parse('{"first":1,"' + name + '":2}');
	} catch (error) {
		rejected = error instanceof SyntaxError;
	}
	if (!rejected) throw new Error("record prediction accepted an unescaped key");
}

const protoRecord = JSON.parse('{"first":1,"__proto__":{"value":2},"first":3}');
if (
	Object.getPrototypeOf(protoRecord) !== Object.prototype ||
	!Object.hasOwn(protoRecord, "__proto__") ||
	protoRecord.__proto__.value !== 2 ||
	protoRecord.first !== 3
)
	throw new Error("record prediction changed CreateDataProperty semantics");
console.log(JSON.stringify({ expectedMemoHits: iterations * 2 }));
