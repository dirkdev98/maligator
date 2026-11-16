const functions = [];
for (let i = 0; i < 256; i++) {
	functions.push(`function stackGrowth${i}() { return ${i}; }`);
}
const source = `[${functions.join(",")}]`;
const recompilingChild = (0, eval)(`(async function recompilingChild(source) {
	await Promise.resolve();
	const generated = (0, eval)(source);
	if (generated[255]() !== 255) throw new Error("runtime compilation failed");
	return new Error("after runtime compilation").stack;
})`);
const awaitingParent = (0, eval)(`(async function awaitingParent(child, source) {
	return await child(source);
})`);

const stack = await awaitingParent(recompilingChild, source);
if (typeof stack !== "string" || !stack.includes("awaitingParent")) {
	throw new Error("async stack lost its awaiting caller: " + stack);
}
const awaitingGenerator = (0, eval)(`(async function* awaitingGenerator(child, source) {
	yield await child(source);
})`);
const mixed = await awaitingGenerator(recompilingChild, source).next();
if (typeof mixed.value !== "string" || !mixed.value.includes("awaitingGenerator")) {
	throw new Error("async stack lost its generator caller: " + mixed.value);
}
console.log("ASYNC STACK EVAL PASS");
