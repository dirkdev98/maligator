function scanToken(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return { text: text.slice(start, end), start, end };
}

function forwardToken(text, start, options) {
	const token = scanToken(text, start);
	for (let step = 0; step < start; step++) {
		if (options.skipAt === step) return { text: "skipped", start, end: start };
	}
	return token;
}

function uppercaseToken(text, start) {
	const token = scanToken(text, start);
	let upper = token.text;
	for (let step = 0; step <= start; step++) upper = upper.toUpperCase();
	return { text: upper, start: token.start, end: token.end };
}

function readTokens(text, options) {
	let output = "";
	for (let index = 0; index < text.length;) {
		const forwarded = forwardToken(text, index, options);
		const upper = uppercaseToken(text, index);
		output += `${forwarded.text}:${upper.text}:${upper.start}:${forwarded.end};`;
		index = forwarded.end + 1;
	}
	return output;
}

console.log(readTokens("cedar spruce birch", { skipAt: -1 }));
console.log(readTokens("elm ash oak", { skipAt: 1 }));
