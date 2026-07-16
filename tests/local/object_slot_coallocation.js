function check(label, condition) {
	if (!condition) throw new Error(label);
}

const retained = [];
for (let i = 0; i < 2000; i++) retained.push({ value: "value:" + i });
check("retained value", retained[1999].value === "value:1999");

const churn = [];
for (let i = 0; i < 500; i++) {
	churn.push({ value: i });
	check("churn", churn.pop().value === i);
}

const overwritten = { value: "before" };
overwritten.value = "after";
check("overwrite", overwritten.value === "after");

const grown = { value: 1 };
grown.extra = 2;
check("growth", grown.value === 1 && grown.extra === 2);

const deleted = { value: 3 };
check("delete", delete deleted.value && !("value" in deleted));

const indexed = { value: 4 };
indexed[0] = 5;
check("index", indexed.value === 4 && indexed[0] === 5);

const symbol = Symbol("slot");
const symbolized = { value: 6 };
symbolized[symbol] = 7;
check("symbol", symbolized.value === 6 && symbolized[symbol] === 7);

const frozen = Object.freeze({ value: 8 });
check("freeze", frozen.value === 8 && Object.isFrozen(frozen));

const sealed = Object.seal({ value: 9 });
check("seal", sealed.value === 9 && Object.isSealed(sealed));

const fixed = Object.preventExtensions({ value: 10 });
fixed.value = 11;
check("prevent extensions", fixed.value === 11 && !Object.isExtensible(fixed));

console.log("object-slot-coallocation PASS 10/10");
