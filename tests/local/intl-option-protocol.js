const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});

for (const name of ["Collator", "NumberFormat", "DateTimeFormat", "PluralRules"]) {
	const Constructor = Intl[name];
	for (const value of [null, true, 1, "invalid", "LOOKUP"]) {
		let rejected = false;
		try {
			new Constructor("en", { localeMatcher: value });
		} catch (error) {
			rejected = error instanceof RangeError;
		}
		if (!rejected) throw new Error(`${name} accepted an invalid localeMatcher`);
	}
	const events = [];
	const options = {
		get localeMatcher() {
			events.push("matcher");
			collect();
			return {
				toString() {
					events.push("coerce");
					collect();
					return "lookup";
				},
			};
		},
	};
	const formatter = new Constructor("de", options);
	if (events.join(",") !== "matcher,coerce")
		throw new Error(`${name} repeated or reordered matcher coercion`);
	if (formatter.resolvedOptions().locale !== "de")
		throw new Error(`${name} lost its locale during option coercion`);
}

const events = [];
const options = new Proxy(
	{},
	{
		get(_target, key) {
			events.push(key);
			collect();
			return undefined;
		},
	},
);
new Intl.Collator("en", options);
if (
	events.join(",") !==
	"usage,localeMatcher,collation,numeric,caseFirst,sensitivity,ignorePunctuation"
)
	throw new Error("Collator option order changed");

for (const Constructor of [
	Intl.Collator,
	Intl.NumberFormat,
	Intl.DateTimeFormat,
	Intl.PluralRules,
	Intl.ListFormat,
]) {
	let reads = 0;
	const newTarget = new Proxy(Constructor, {
		get(target, key) {
			if (key === "prototype") {
				reads++;
				collect();
			}
			return Reflect.get(target, key);
		},
	});
	Reflect.construct(Constructor, ["en"], newTarget);
	if (reads !== 1) throw new Error("constructor repeated prototype lookup");
}

console.log("ok");
