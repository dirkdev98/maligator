function score(value) {
	return value + 1;
}

function alternateScore(value) {
	return value - 1;
}

function totalScores(values) {
	let total = 0;
	for (let round = 0; round < 2_500; round++) {
		const scores = values.map(score);
		total += scores[0] + scores[3];
	}
	return total;
}

const values = [1, 2, 3, 4];
const alternatives = new Map([["alternate", alternateScore]]);
console.log(totalScores(values), score(7));
score = alternatives.get("alternate");
console.log(values.map(score).join(","));
