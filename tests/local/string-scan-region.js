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

// Tables in global bindings: units past a table's end read undefined in the original loop.
function tokenEnd(str, from) {
	let i = from;
	while (i < str.length && TOKEN[str.charCodeAt(i)] === 1) i++;
	return i;
}

function crcText(str) {
	let crc = -1;
	for (let i = 0; i < str.length; i++)
		crc = CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

function classWeights(str) {
	let total = 0;
	for (let i = 0; i < str.length; i++) total += WEIGHTS[str.charCodeAt(i) & 7];
	return total;
}

function swappedSum(str) {
	let total = 0;
	for (let i = 0; i < str.length; i++) total += swapped[str.charCodeAt(i) & 3];
	return total;
}

function lateSum(str) {
	let total = 0;
	for (let i = 0; i < str.length; i++) total += LATE[str.charCodeAt(i) & 1];
	return total;
}

// Bindings of an enclosing function, as at a CommonJS module's top level.
function makeFieldScanner(log) {
	for (const sample of ["", "a,b"]) {
		try {
			log.push(fieldEnd(sample, 0));
		} catch (error) {
			log.push(error.constructor.name);
		}
	}
	const COMMA = 0x2c;
	const WEIGHT = new Uint8Array([3, 1, 4, 1]);
	let offset = 1;
	function fieldEnd(str, from) {
		let i = from;
		while (i < str.length && str.charCodeAt(i) !== COMMA) i++;
		return i;
	}
	function weighted(str) {
		let total = 0;
		for (let i = 0; i < str.length; i++)
			total += WEIGHT[(str.charCodeAt(i) + offset) & 3];
		return total;
	}
	return {
		fieldEnd,
		weighted,
		shift(by) {
			offset = by;
		},
	};
}
const fieldLog = [];
const fields = makeFieldScanner(fieldLog);

const beforeInit = [];
for (const sample of ["", "ab"]) {
	try {
		beforeInit.push(lateSum(sample));
	} catch (error) {
		beforeInit.push(error.constructor.name);
	}
}
const LATE = new Int16Array([-3, 5]);
const TOKEN = new Uint8Array(128);
for (const char of "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
	TOKEN[char.charCodeAt(0)] = 1;
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c;
}
const WEIGHTS = [0.5, 1, 2, -4, 8, 16.25, 32, 64];
let swapped = new Float64Array([1.5, 2, 3, 4]);

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
			tokenEnd(sample, start),
			crcText(sample),
			classWeights(sample),
			swappedSum(sample),
			lateSum(sample),
			fields.fieldEnd(sample, 0),
			fields.weighted(sample),
		].join(" "),
	);
}
lines.push(`before init ${beforeInit.join(" ")} ${fieldLog.join(" ")}`);
for (const by of [2, 0.5, -1, "1", 2 ** 53]) {
	fields.shift(by);
	lines.push(`shifted ${by} ${fields.weighted("abcdefgh")}`);
}
for (const table of [[7, 8, 9, 10], new Uint16Array([65535, 1, 2, 3]), { 0: 1 }, null]) {
	swapped = table;
	try {
		lines.push(`swapped ${swappedSum("abcd")} ${swappedSum("")}`);
	} catch (error) {
		lines.push(`swapped ${error.constructor.name}`);
	}
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
