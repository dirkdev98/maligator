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
console.log(JSON.stringify({ expectedMemoHits: iterations * 2 }));
