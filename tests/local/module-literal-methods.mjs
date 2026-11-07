const api = {
	add(a, b) {
		return a + b;
	},
	mul(a, b) {
		return a * b;
	},
};
let tools = {
	scale(value) {
		return value * 2;
	},
};

function sum(n) {
	let acc = 0;
	for (let i = 0; i < n; i++) acc = api.add(acc, api.mul(i & 15, 3)) | 0;
	return acc;
}

function scaled(n) {
	let acc = 0;
	for (let i = 0; i < n; i++) acc = (acc + tools.scale(i & 7)) | 0;
	return acc;
}

const results = [sum(1000), scaled(1000)];
// The guessed method stays a guess: replacing it, or the whole object, takes the generic call.
api.add = (a, b) => a - b;
results.push(sum(1000));
api.mul = Math.max;
results.push(sum(1000));
tools = { scale: (value) => value + 1 };
results.push(scaled(1000));
const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") gc();
tools.scale = function (value) {
	return this === tools ? value * 3 : -1;
};
results.push(scaled(1000));
console.log(results.join(" "));
