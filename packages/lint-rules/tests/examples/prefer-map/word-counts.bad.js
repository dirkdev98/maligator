// Every word that becomes a key gives the object a new shape, so shapes pile
// up with the data instead of with the code.
function countWords(words) {
	const counts = {};
	for (const word of words) counts[word] = (counts[word] ?? 0) + 1;
	return counts;
}

let total = 0;
for (let round = 0; round < 10_000; round++) {
	const counts = countWords([`w${round}`, `w${round % 7}`, `w${round}`]);
	total += counts[`w${round}`];
}
console.log(total);
