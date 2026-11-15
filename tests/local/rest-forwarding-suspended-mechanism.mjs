function sum(a = 0, b = 0) {
	return a + b;
}
async function asyncForward(...values) {
	await 0;
	return sum(...values);
}
function* generatorForward(...values) {
	yield 1;
	return sum(...values);
}
async function* asyncGeneratorForward(...values) {
	await 0;
	yield 1;
	return sum(...values);
}
let checksum = 0;
for (let i = 0; i < 6; i++) {
	checksum += await asyncForward(2, 3);
	const generator = generatorForward(2, 3);
	if (generator.next().value !== 1) throw Error("yield");
	checksum += generator.next().value;
	const asyncGenerator = asyncGeneratorForward(2, 3);
	if ((await asyncGenerator.next()).value !== 1) throw Error("async yield");
	checksum += (await asyncGenerator.next()).value;
}
if (checksum !== 90) throw Error("checksum");
console.log("rest-forwarding-suspended-mechanism PASS");
