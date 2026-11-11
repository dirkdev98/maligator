const patterns = [
	/^(?<word>[a-z]+):\k<word>:(\d+)(?:,(x+))?$/d,
	/^(?<word>[^:]+):\k<word>:(\d+)(?:,(x+))?$/du,
	/^(?<word>[^:]+):\k<word>:(\d+)(?:,(x+))?$/d,
	/^(?:(?<part>a)|(?<part>b))\k<part>$/d,
	/(?<letter>[a-z])\k<letter>/dg,
	/(?<empty>)(?=.)/dgy,
];
const output = [];
const retained = [];
for (let round = 0; round < 3; round++) {
	const words = [
		"a".repeat(300 + round),
		"é".repeat(300),
		"😀".repeat(160),
		"\ud800".repeat(300),
	];
	for (let index = 0; index < patterns.length; index++) {
		const pattern = patterns[index];
		for (const word of words) {
			for (const ending of [":123,xxx", ":4", ":missing"]) {
				const subject = word + ":" + word + ending;
				for (const start of [0, 1, subject.length + 1, 0]) {
					pattern.lastIndex = start;
					const match = pattern.exec(subject);
					if (match) retained.push(match);
					output.push([
						index,
						match && [
							match[0],
							...match.slice(1),
							match.index,
							match.groups,
							match.indices,
						],
						pattern.lastIndex,
					]);
				}
			}
		}
	}
	if (globalThis.gc) gc();
}
for (const text of ["aa", "bb", "ab", "bb", "aa"]) {
	const match = patterns[3].exec(text);
	if (match) retained.push(match);
	output.push([text, match && [match[0], match.groups, match.indices]]);
}
const repeated = /(?<token>[a-z]+)\k<token>/dg;
const long = "ababcddcabab".repeat(40);
let match;
while ((match = repeated.exec(long)))
	output.push([match[0], match.index, match.groups.token]);
output.push("aa::bb::cc".split(/(:)\1/));
output.push(retained.map((match) => [match[0].length, match.groups, match.indices]));
console.log(JSON.stringify(output));
