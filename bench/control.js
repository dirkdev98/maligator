// Control-flow heavy: for-of iteration + try/catch in a hot function. Before
// the emit-c opcode expansion these constructs forced the function onto the
// bytecode interpreter; now `classify` compiles to native C. Bounded memory:
// one fixed array iterated many times, exceptions thrown/caught per iteration.

function classify(values) {
	let sum = 0;
	let errors = 0;
	for (const v of values) {
		try {
			if (v % 7 === 0) {
				throw "div7";
			}
			sum = sum + (v % 100);
		} catch (e) {
			errors = errors + 1;
		}
	}
	return sum + errors * 1000;
}

const data = [];
for (let i = 0; i < 2000; i++) {
	data.push(i * 31 + 1);
}

let acc = 0;
for (let iter = 0; iter < 5000; iter++) {
	acc = (acc + classify(data)) % 1000000007;
}
console.log(acc);
