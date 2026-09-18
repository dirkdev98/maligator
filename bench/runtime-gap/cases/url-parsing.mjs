import { parse as parseUrl } from "node:url";
import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function urlParsing(scale) {
	let checksum = 0;
	const operations = 25_000 * scale;
	for (let index = 0; index < operations; index++) {
		const url = parseUrl(`https://example.test/path/${index & 255}?q=${index & 63}#part`);
		checksum += url.pathname.length + url.search.length + url.hash.length;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("url-parsing", urlParsing);
