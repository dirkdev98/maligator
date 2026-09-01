let closed = false;

function* numbers() {
	try {
		yield 3;
		yield 4;
	} finally {
		closed = true;
	}
}

async function run() {
	const iterator = numbers();
	const first = iterator.next().value;
	const second = iterator.next().value;
	iterator.return();
	let exception = "missed";
	try {
		throw new Error("caught");
	} catch (error) {
		exception = error.message;
	}
	await Promise.resolve();
	return `core-empty-optimizer:${first + second}:${exception}:${closed}`;
}

console.log(await run());
