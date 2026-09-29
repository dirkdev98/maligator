function readLength(values, fallback) {
	const length = values.length;
	return fallback.keep ? length + 1 : length;
}

const fallback = {
	keep: false,
	get length() {
		return 9;
	},
};

globalThis.readLength = readLength;
console.log(globalThis.readLength([4, 5, 6], fallback));
