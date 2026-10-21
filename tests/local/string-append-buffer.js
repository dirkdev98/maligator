// Appends that share one buffer must never let one result observe another's bytes.
function grow(seed, count, piece) {
	let text = seed;
	for (let index = 0; index < count; index++) text += piece(index);
	return text;
}

const lines = [];
const base = grow("start:", 80, (index) => `${index},`);
const left = base + "LEFT";
const right = base + "RIGHT";
const leftAgain = left + "!";
lines.push(
	`branches ${left.slice(-12)} ${right.slice(-12)} ${leftAgain.slice(-6)} ${base.length}`,
);

const frozen = base.slice(0);
const extended = base + "-more";
lines.push(
	`slice ${frozen === base} ${frozen.length} ${extended.endsWith("-more")} ${frozen.endsWith(",")}`,
);

const wide = grow("latin:", 40, (index) => (index === 20 ? "☃" : "x"));
lines.push(
	`encoding ${wide.length} ${wide.indexOf("☃")} ${wide.charCodeAt(26)} ${wide.at(-1)}`,
);

const widened = grow("w:", 60, (index) => String.fromCharCode(97 + (index % 26)));
const unit = widened.charCodeAt(30);
const afterWiden = widened + "é" + "tail";
lines.push(`widen ${unit} ${afterWiden.slice(-5)} ${afterWiden.length}`);

const keys = new Map();
for (let round = 0; round < 3; round++)
	keys.set(
		grow("key", 30, (index) => index % 10),
		round,
	);
lines.push(`hash ${keys.size} ${keys.get(grow("key", 30, (index) => index % 10))}`);

const object = {};
object[grow("prop", 25, () => "p")] = 7;
lines.push(
	`property ${Object.keys(object)[0].length} ${object["prop" + "p".repeat(25)]}`,
);

let churn = "";
const kept = [];
for (let index = 0; index < 3000; index++) {
	churn += String(index % 7);
	if (index % 500 === 0) kept.push(churn);
	if (index % 97 === 0) [].push({ index, text: `t${index}` });
}
lines.push(
	`churn ${churn.length} ${kept.map((text) => text.length).join(",")} ${kept[3].slice(-4)}`,
);

console.log(lines.join("\n"));
