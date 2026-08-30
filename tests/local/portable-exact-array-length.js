function readLength(fallback) {
	const values = [4, 5, 6];
	const length = values.length;
	return fallback.keep ? length + 1 : length;
}

const fallback = {
	keep: false,
	get length() {
		return 9;
	},
};

console.log(readLength(fallback));
