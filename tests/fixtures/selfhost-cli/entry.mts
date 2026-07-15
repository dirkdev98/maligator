const expected = ["alpha", "two words", "--flag"];
const actual = process.argv.slice(2);
if (
	actual.length !== expected.length ||
	actual.some((value, index) => value !== expected[index])
) {
	// eslint-disable-next-line no-console -- integration fixture protocol.
	console.log(`unexpected argv: ${JSON.stringify(actual)}`);
	process.exit(17);
}
// eslint-disable-next-line no-console -- integration fixture protocol.
console.log(`selfhost-cli ${actual.join("|")}`);
