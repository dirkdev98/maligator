let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("array-search-direct failure: " + name);
	checks++;
}

function has(array, value, from) {
	return array.includes(value, from);
}
function first(array, value, from) {
	return array.indexOf(value, from);
}
function last(array, value, from) {
	return array.lastIndexOf(value, from);
}

const values = [0, 1, 2, 1, NaN, -0];
ok("includes hit", has(values, 2, 0));
ok("includes miss", !has(values, 3, 0));
ok("includes nan", has(values, NaN, 0));
ok("includes signed zero", has(values, 0, 5));
ok("includes negative from", has(values, 1, -3));
ok("index first", first(values, 1, 0) === 1);
ok("index from", first(values, 1, 2) === 3);
ok("index nan", first(values, NaN, 0) === -1);
ok("last", last(values, 1, 5) === 3);
ok("last negative from", last(values, 1, -4) === 1);

const hole = new Array(1);
ok("includes sees hole as undefined", has(hole, undefined, 0));
ok("index skips hole", first(hole, undefined, 0) === -1);
ok("last index skips hole", last(hole, undefined, 0) === -1);

let coercions = 0;
const coerciveFrom = {
	valueOf() {
		coercions++;
		return 1;
	},
};
ok("coercive includes fallback", has(values, 1, coerciveFrom) && coercions === 1);
ok("coercive index fallback", first(values, 1, coerciveFrom) === 1 && coercions === 2);
ok("coercive last fallback", last(values, 1, coerciveFrom) === 1 && coercions === 3);

let inheritedReads = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		inheritedReads++;
		return 41;
	},
});
ok("inherited includes", has(hole, 41, 0) && inheritedReads === 1);
ok("inherited index", first(hole, 41, 0) === 0 && inheritedReads === 2);
ok("inherited last", last(hole, 41, 0) === 0 && inheritedReads === 3);
delete Array.prototype[0];

const own = [1, 2];
own.includes = () => "own includes";
own.indexOf = () => 17;
own.lastIndexOf = () => 19;
ok("own includes override", has(own, 2, 0) === "own includes");
ok("own index override", first(own, 2, 0) === 17);
ok("own last override", last(own, 2, 0) === 19);

const intrinsicIncludes = Array.prototype.includes;
const intrinsicIndexOf = Array.prototype.indexOf;
const intrinsicLastIndexOf = Array.prototype.lastIndexOf;
Array.prototype.includes = () => "prototype includes";
Array.prototype.indexOf = () => 23;
Array.prototype.lastIndexOf = () => 29;
ok("prototype includes override", has(values, 2, 0) === "prototype includes");
ok("prototype index override", first(values, 2, 0) === 23);
ok("prototype last override", last(values, 2, 0) === 29);
Array.prototype.includes = intrinsicIncludes;
Array.prototype.indexOf = intrinsicIndexOf;
Array.prototype.lastIndexOf = intrinsicLastIndexOf;

const proxy = new Proxy([4, 5], {});
ok("proxy includes fallback", has(proxy, 5, 0));
ok("proxy index fallback", first(proxy, 5, 0) === 1);
ok("proxy last fallback", last(proxy, 5, 1) === 1);
ok("generic includes fallback", intrinsicIncludes.call({ 0: 9, length: 1 }, 9));
ok("generic index fallback", intrinsicIndexOf.call({ 0: 9, length: 1 }, 9) === 0);
ok("generic last fallback", intrinsicLastIndexOf.call({ 0: 9, length: 1 }, 9) === 0);

let effects = 0;
ok("includes extra arguments", values.includes(2, 0, ++effects) && effects === 1);
ok("index extra arguments", values.indexOf(2, 0, ++effects) === 2 && effects === 2);
ok("last extra arguments", values.lastIndexOf(2, 5, ++effects) === 2 && effects === 3);

console.log(checks === 34 ? "array-search-direct PASS" : "array-search-direct FAIL");
