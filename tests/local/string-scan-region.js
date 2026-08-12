function scanFast(line) {
	const out = [];
	let matches = 0;
	for (let index = 0; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (code === 32) {
			out.push({ kind: "separator", index });
			matches++;
		} else {
			out.push({ kind: "character", code, index });
		}
	}
	return { tokens: out, matches };
}

function scanPatchedPush(line) {
	const out = [];
	let matches = 0;
	for (let index = 0; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (code === 32) {
			out.push({ kind: "separator", index });
			matches++;
		} else {
			out.push({ kind: "character", code, index });
		}
	}
	return { tokens: out, matches };
}

let fastChecksum = 0;
for (let iteration = 0; iteration < 6000; iteration++) {
	const result = scanFast("a b " + iteration);
	fastChecksum += result.tokens.length + result.matches;
}

const originalPush = Array.prototype.push;
let pushCalls = 0;
Array.prototype.push = function (value) {
	pushCalls++;
	return originalPush.call(this, value);
};
let fallbackChecksum = 0;
for (let iteration = 0; iteration < 6000; iteration++) {
	const result = scanPatchedPush("a b " + iteration);
	fallbackChecksum += result.tokens.length + result.matches;
}

const passed =
	fastChecksum === 58890 && fallbackChecksum === 58890 && pushCalls === 46890;
console.log(
	`RESULT ${passed ? "PASS" : "FAIL"} ${fastChecksum} ${fallbackChecksum} ${pushCalls}`,
);
