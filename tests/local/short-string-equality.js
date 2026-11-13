const results = [];
function same(left, right) {
	return left === right;
}
function fresh(text) {
	return text.split("").join("");
}

const alphabet = "abcdefghijklmnopqrstuvwxyz";
let equalCount = 0;
let differenceCount = 0;
for (let length = 1; length <= 17; length++) {
	const base = fresh(alphabet.slice(0, length));
	if (same(base, fresh(alphabet.slice(0, length)))) equalCount++;
	for (let position = 0; position < length; position++) {
		const changed = base.slice(0, position) + "#" + base.slice(position + 1);
		if (!same(base, changed) && !same(changed, base)) differenceCount++;
	}
}
results.push(`equal=${equalCount}`, `differences=${differenceCount}`);

const latin1 = fresh("café");
const widened = fresh("café€").slice(0, 4);
results.push(`latin1VsUtf16=${same(latin1, widened)},${same(widened, latin1)}`);
results.push(
	`highLatin1=${same(fresh("ÿþ"), fresh("ÿþ"))},${same(fresh("ÿþ"), fresh("ÿý"))}`,
);

const attribute = fresh("abcdefghij");
"x".link(attribute);
results.push(
	`widenedInPlace=${same(attribute, fresh("abcdefghij"))},${same(attribute, fresh("abcdefghiJ"))}`,
);
results.push(`empty=${same(fresh(""), "")}`);
results.push(`mixedKinds=${same("1", 1)},${same(fresh("ab"), { toString: () => "ab" })}`);

console.log(results.join("\n"));
