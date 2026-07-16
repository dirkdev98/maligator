function allocateEscaping() {
	const value = {};
	globalThis.escaped = value;
	return value;
}

function failThroughNestedCall() {
	__mal_fail_next_cell_allocation();
	return allocateEscaping();
}

let first;
try {
	failThroughNestedCall();
} catch (error) {
	first = error;
	console.log(error instanceof Error, error.message);
}

const recovered = allocateEscaping();
console.log(typeof recovered, recovered === globalThis.escaped);

try {
	failThroughNestedCall();
} catch (error) {
	console.log(error === first, error.message);
}
