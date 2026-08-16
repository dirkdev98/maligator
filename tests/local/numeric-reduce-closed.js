let result = 0;
for (let round = 0; round < 100; round++) {
	result += [0.25, 1, 4, 9, 16].reduce((sum, value) => sum + Math.sqrt(value), 0.25);
}

if (!Object.is(result, 1075)) {
	throw new Error(`closed numeric reduce result ${result}`);
}

console.log("numeric-reduce-closed PASS 1/1");
