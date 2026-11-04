import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";

const mode = process.env.MAL_FS_ENCODING_CASE ?? "utf8";
const cases = {
	utf8: ["aé😀\ud800", "utf8", "61c3a9f09f9880efbfbd"],
	utf16le: ["aé😀\ud800", "utf16le", "6100e9003dd800de00d8"],
	latin1: ["aé\u0101", "latin1", "61e901"],
	ascii: ["aé\u0101", "ascii", "61e901"],
	hex: ["6162z3", "hex", "6162"],
	oddhex: ["616", "hex", "61"],
	base64: [" Y W J j \n Z A", "base64", "61626364"],
	base64url: ["_-4", "base64url", "ffee"],
	empty: ["", "utf8", ""],
	large: [
		"YQ==" + (mode === "large" ? " ".repeat(192 * 1024 * 1024) : ""),
		"base64",
		"61",
	],
};
const [text, encoding, expected] = cases[mode];
const directory = mkdtempSync("/tmp/mal-encoded-write-");
try {
	const file = directory + "/output";
	await writeFile(file, text, encoding);
	if (readFileSync(file).toString("hex") !== expected)
		throw new Error("encoded write bytes");
	await appendFile(file, text, encoding);
	if (readFileSync(file).toString("hex") !== expected + expected)
		throw new Error("encoded append bytes");
	console.log("encoded writes PASS");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
