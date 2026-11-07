// Arrays chosen by a condition reach `length` reads whose value no single literal
// fixes; the read must see the chosen array's own length, never the prototype's.
const choose = (flag) => (flag ? [1, 2] : [1, 2, 3]);
const unequal = (flag) => {
	const pairs = flag ? [1, 2] : [1, 2, 3];
	return pairs.length;
};
const holey = (flag) => {
	const pairs = flag ? [1, , 3] : [1, 2];
	return pairs.length;
};
const pickIndex = (seed, minimum, span, divisor = 1) =>
	minimum + (Math.floor(seed / divisor) % span);
const throughHelper = (tier, seed) => {
	const pairs =
		tier === "small"
			? [
					[2, 4],
					[3, 6],
					[4, 8],
					[5, 10],
				]
			: [
					[3, 4],
					[5, 6],
					[4, 9],
					[7, 12],
					[8, 15],
				];
	const index = pickIndex(seed, 0, pairs.length);
	const [first = 3, second = 4] = pairs[index] ?? [];
	return `${pairs.length}:${index}:${first}:${second}`;
};
console.log(
	unequal(true),
	unequal(false),
	holey(true),
	holey(false),
	choose(true).length,
	throughHelper("large", 3133055334),
	throughHelper("small", 7),
);
