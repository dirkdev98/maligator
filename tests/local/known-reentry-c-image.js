function probe(value) {
	return Number.isFinite(Number(value));
}
let coercions = 0;
const value = {
	valueOf() {
		coercions++;
		Number.isFinite = () => false;
		return 7;
	},
};
if (probe(value) !== true || coercions !== 1) throw new Error("captured predicate");
console.log("known-reentry-c-image PASS");
