// String scans read code units in a loop region; anything but a primitive string's
// in-range units must finish in the original loop with the same result.
const SEMI = 0x3b;

function skipValue(str, index, len) {
	while (index < len) {
		const char = str.charCodeAt(index);
		if (char === SEMI) break;
		index++;
	}
	return index;
}

function skipSpaces(str, index, len) {
	while (index < len) {
		const char = str.charCodeAt(index);
		if (char !== 0x20 && char !== 0x09) break;
		index++;
	}
	return index;
}

function hashUnits(str) {
	let hash = 2166136261;
	for (let i = 0; i < str.length; i++)
		hash = Math.imul(hash ^ str.charCodeAt(i), 16777619) >>> 0;
	return hash;
}

function evenUnits(str, count) {
	let total = 0;
	for (let i = 0; i < count; i++) total += str.charCodeAt(i * 2);
	return total;
}

function lastDigitRun(str) {
	let end = str.length - 1;
	for (; end >= 0; end--) {
		const char = str.charCodeAt(end);
		if (char < 0x30 || char > 0x39) break;
	}
	return end;
}

function countWords(str) {
	let words = 0;
	let i = 0;
	while (i < str.length) {
		while (i < str.length && str.charCodeAt(i) === 0x20) i++;
		if (i < str.length) words++;
		while (i < str.length && str.charCodeAt(i) !== 0x20) i++;
	}
	return words;
}

const lines = [];
const samples = [
	"application/x-www-form-urlencoded",
	"text/html; charset=utf-8",
	"   \t  application/json",
	"",
	";",
	"café; q=0.9",
	"\u{1f600} emoji; tail",
	"  ;￿",
];
const sliced = "xx text/plain; charset=ascii yy".slice(3, -3);
const rope = ["text/", "plain", "; ", "charset=", "ascii"].reduce(
	(left, right) => left + right,
);
for (const sample of [...samples, sliced, rope]) {
	const start = skipSpaces(sample, 0, sample.length);
	lines.push(
		[
			JSON.stringify(sample),
			start,
			skipValue(sample, start, sample.length),
			skipValue(sample, 0, sample.length + 3),
			hashUnits(sample),
			evenUnits(sample, sample.length >> 1),
			evenUnits(sample, sample.length),
			lastDigitRun(sample + "123"),
			countWords(sample),
		].join(" "),
	);
}
lines.push(`fractional start ${skipValue("ab;cd", 0.5, 5)}`);
lines.push(`negative start ${skipValue("ab;cd", -2, 5)}`);
lines.push(`string object ${skipValue(new String("ab;cd"), 0, 5)}`);
lines.push(
	`array receiver ${(() => {
		try {
			return skipValue([1, 2, 3], 0, 3);
		} catch (error) {
			return error.constructor.name;
		}
	})()}`,
);
const long = "x".repeat(5000) + ";" + "y".repeat(10);
for (let round = 0; round < 50; round++) skipValue(long, 0, long.length);
lines.push(`long ${skipValue(long, 0, long.length)} ${hashUnits(long)}`);
console.log(lines.join("\n"));
