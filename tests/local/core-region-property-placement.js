function locked(value) {
	const match = /(\d+)x/.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
}

let getterCalls = 0;
const supplied = {
	get exec() {
		getterCalls++;
		return function (value) {
			const match = /(\d+)x/.exec(value);
			return match;
		};
	},
};

function open(receiver, value) {
	const match = receiver.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
}

const result = [locked("42x"), open(supplied, "7x"), open(supplied, "9x")];
console.log(`RESULT ${result.join(",")} getters=${getterCalls}`);
