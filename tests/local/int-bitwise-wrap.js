const values = [93911755, 4294967295, 4294967296, 4294967297, -4294967297, 3000000000];
const checks = [
	values[0] << 5 === -1289791136,
	(values[1] | 0) === -1,
	(values[2] | 0) === 0,
	(values[3] | 0) === 1,
	(values[4] | 0) === -1,
	(values[5] | 0) === -1294967296,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
