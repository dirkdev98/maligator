let closed = false;
function* numbers() {
	try {
		yield 1;
		yield 2;
		yield 3;
	} finally {
		closed = true;
	}
}

let sum = 0;
for (const number of numbers()
	.map((number) => number * 2)
	.take(2))
	sum += number;
console.log(`${sum},${closed}`);
