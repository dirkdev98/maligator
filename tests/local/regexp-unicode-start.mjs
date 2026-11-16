const prefix = "Σ😀".repeat(100);
const specs = {
	single: ["(?<tag>a)\\k<tag>", "u", prefix + "aa", 0],
	two: ["(?<tag>[ab])\\k<tag>", "u", prefix + "bb", 0],
	three: ["(?<tag>[abc])\\k<tag>", "u", prefix + "cc", 0],
	bracket: ["(?<tag>[a-z]+):\\k<tag>", "du", prefix + "alpha:alpha", 0],
	sequence: ["(?<tag>alpha):\\k<tag>", "u", prefix + "alpha:alpha", 0],
	miss: ["(?<tag>[a-z]+):\\k<tag>", "u", prefix, 0],
	anchored: ["^(?<tag>[a-z]+):\\k<tag>", "u", prefix + "alpha:alpha", 0],
	stickyHit: ["(?<tag>[a-z]+):\\k<tag>", "uy", prefix + "alpha:alpha", prefix.length],
	stickyMiss: ["(?<tag>[a-z]+):\\k<tag>", "uy", prefix + "alpha:alpha", 0],
	global: ["(?<tag>[a-z]+):\\k<tag>", "gu", prefix + "alpha:alpha", 0],
	codeUnits: ["(?<tag>[a-z]+):\\k<tag>", "", prefix + "alpha:alpha", 0],
	wideStart: ["(?<tag>Σ)\\k<tag>", "u", "😀".repeat(100) + "ΣΣ", 0],
	mixedStart: ["(?<tag>[aΣ])\\k<tag>", "u", "😀".repeat(100) + "ΣΣ", 0],
	kelvin: ["(?<tag>k)\\k<tag>", "iu", prefix + "KK", 0],
	longS: ["(?<tag>s)\\k<tag>", "iu", prefix + "ſS", 0],
	emptyAlternative: ["(?:(?<tag>[a-z])\\k<tag>|)", "u", prefix, 0],
	lookahead: ["(?=aa)(?<tag>a)\\k<tag>", "u", prefix + "aa", 0],
	multiline: ["^(?<tag>a)\\k<tag>", "mu", prefix + "\naa", 0],
	loneSurrogates: ["(?<tag>a)\\k<tag>", "u", "\ud800Σ\udc00".repeat(100) + "aa", 0],
	insideSurrogate: ["(?<tag>a)\\k<tag>", "gu", "😀".repeat(100) + "aa", 1],
	bmpRange: ["(?<tag>[Σ-Ω])\\k<tag>", "u", "😀".repeat(100) + "ΣΣ", 0],
	astralRange: [
		"(?<tag>[\\u{1F600}-\\u{1F601}])\\k<tag>",
		"u",
		"Σ".repeat(100) + "😀😀",
		0,
	],
	highSurrogateUnits: [
		"(?<tag>[\\uD800-\\uDBFF])\\k<tag>",
		"",
		"Σ😀".repeat(100) + "\ud800\ud800",
		0,
	],
	highSurrogateUnicode: [
		"(?<tag>[\\uD800-\\uDBFF])\\k<tag>",
		"u",
		"Σ😀".repeat(100) + "\ud800\ud800",
		0,
	],
	lowSurrogateUnits: [
		"(?<tag>[\\uDC00-\\uDFFF])\\k<tag>",
		"",
		"Σ😀".repeat(100) + "\udc00\udc00",
		0,
	],
	lowSurrogateUnicode: [
		"(?<tag>[\\uDC00-\\uDFFF])\\k<tag>",
		"u",
		"Σ😀".repeat(100) + "\udc00\udc00",
		0,
	],
	coarsePrefix: ["(?<tag>[Σ-Ω])\\k<tag>", "u", "ΑΒ".repeat(100) + "ΣΣ", 0],
	broadPredicate: ["(?<tag>[^:])\\k<tag>!", "u", "Σ😀".repeat(100) + "aa!", 0],
};
const output = {};
for (const [name, [source, flags, subject, start]] of Object.entries(specs)) {
	const pattern = new RegExp(source, flags);
	pattern.lastIndex = start;
	const match = pattern.exec(subject);
	output[name] = match
		? [
				match[0],
				match.index,
				match.groups.tag,
				match.indices?.groups.tag,
				pattern.lastIndex,
			]
		: [null, pattern.lastIndex];
}
console.log(JSON.stringify(output));
