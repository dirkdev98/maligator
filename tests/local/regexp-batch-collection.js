const observations = [];
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});

function replace(source, pattern, replacement) {
	pattern.lastIndex = 17;
	const output = source.replace(pattern, replacement);
	observations.push([output, pattern.lastIndex, RegExp.lastMatch, RegExp.$1, RegExp.$2]);
	collect();
	return output;
}

const many = Array.from({ length: 80 }, (_, index) => `oak=${index}`).join(";");
for (const source of [many, `Σ;${many};😀`, "", "without numbers", "0;1;22;333"]) {
	replace(source, /([a-z]+)=(\d+)/g, "$2:$1");
	replace(source, /\d+/g, "#");
	replace(source, /\d*/g, "|");
	replace(source, /(?<tree>[a-z]+)=(?<amount>\d+)/g, "$<amount>:$<tree>");
	replace(source, /(?:oak|elm)=(\d+)/g, "[$1]");
	replace(source, /[^\w]+/g, " ");
	replace(source, /[a-cx-z]+/g, "+");
}
replace("aa😀a\ud800a", /a{0}/g, "|");
replace("aa😀a\ud800a", /a{0}/gu, "|");
replace("aaa;aa", /a+/gy, "#");
replace("aaa;aa", /a+/y, "#");
replace("aaa;aa", /a+/g, "#");
replace("a;a;ab;a", /a(?=$|;)/g, "x");
replace("ab b ab", /(a)?(b)/g, "$2:$1");
replace("aabczabz", /(([a-c]{1,3})z)/g, "$2/$1");
replace("xabccc", /((ab)(c+))$/g, "$3/$2/$1");
replace("bab", /((a{0})b)/g, "$2/$1");
const wideCaptures = new RegExp("(a)".repeat(24), "g");
replace("a".repeat(48), wideCaptures, "$24/$1");

const callbacks = [];
const pattern = /([a-z]+)=(\d+)/g;
const changed = "oak=7;elm=12".replace(pattern, (match, tree, amount, offset) => {
	callbacks.push([match, tree, amount, offset, pattern.lastIndex, RegExp.lastMatch]);
	collect();
	pattern.lastIndex = 9;
	return `${tree}:${Number(amount) + 1}`;
});
observations.push(changed, callbacks, pattern.lastIndex);

const parts = [
	"0",
	"7",
	"000000001",
	"999999999",
	"1000000000",
	"-0",
	"+7",
	"0xff",
	"1e2",
	"１２",
	"1x",
	"",
];
function numberFromCapture(source) {
	const match = /\|([^|]*)\|/.exec(source);
	if (match === null) throw new Error("missing capture");
	const value = Number(match[1]);
	return [value, Object.is(value, -0), Number.isNaN(value)];
}
for (const part of parts) {
	observations.push(numberFromCapture(`x|${part}|y`));
	observations.push(numberFromCapture(`Σ|${part}|😀`));
}
console.log(JSON.stringify(observations));
