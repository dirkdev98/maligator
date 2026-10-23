// An async body that throws before its first await rejects its promise, even
// when the call sits inside the caller's try block.
const results = [];
function settle(name, start) {
	try {
		return start().then(
			() => results.push(`${name} resolved`),
			(error) => results.push(`${name} rejected ${error.constructor.name}`),
		);
	} catch (error) {
		results.push(`${name} threw ${error.constructor.name}`);
	}
}
async function declared() {
	throw new TypeError("declared");
}
async function* generator() {
	throw new RangeError("generator");
}
function caught() {
	try {
		return declared();
	} catch {
		return "caught synchronously";
	}
}
const pending = [
	settle("declaration", declared),
	settle("expression", async function () {
		null.property;
	}),
	settle("arrow", async () => {
		throw new SyntaxError("arrow");
	}),
	settle("using", async function () {
		using resource = 1;
	}),
	settle("await using", async function () {
		await using resource = Symbol();
	}),
	settle("tdz", async function () {
		binding;
		await using binding = null;
	}),
	settle("after await", async function () {
		await 0;
		throw new EvalError("after");
	}),
	settle("caller handler", async () => caught()),
	settle("generator", () => generator().next()),
];
await Promise.all(pending);
console.log(results.join("\n"));
