// A Map keeps its keys in a hash table, so new words cost no shapes.
function countWords(words) {
	const counts = new Map();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	return counts;
}

let total = 0;
for (let round = 0; round < 10_000; round++) {
	const counts = countWords([`w${round}`, `w${round % 7}`, `w${round}`]);
	total += counts.get(`w${round}`);
}
console.log(total);
