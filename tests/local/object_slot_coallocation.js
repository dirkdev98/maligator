function check(label, condition) {
	if (!condition) throw new Error(label);
}

const retained = [];
for (let i = 0; i < 2000; i++) retained.push({ value: "value:" + i });
check("retained value", retained[1999].value === "value:1999");

const retainedFour = [];
for (let i = 0; i < 2000; i++) {
	retainedFour.push({ a: i, b: "four:" + i, c: i + 2, d: i + 3 });
}
check(
	"retained four",
	retainedFour[1999].a === 1999 && retainedFour[1999].b === "four:1999",
);

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

const grownFour = { a: 1, b: 2, c: 3, d: 4 };
grownFour.extra = 5;
check(
	"four-slot growth",
	grownFour.a === 1 && grownFour.d === 4 && grownFour.extra === 5,
);

const deleted = { value: 3 };
check("delete", delete deleted.value && !("value" in deleted));

const deletedFour = { a: 1, b: 2, c: 3, d: 4 };
check(
	"four-slot delete",
	delete deletedFour.b && deletedFour.a === 1 && !("b" in deletedFour),
);

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

const wide16 = {
	k0: 0,
	k1: 1,
	k2: 2,
	k3: 3,
	k4: 4,
	k5: 5,
	k6: 6,
	k7: 7,
	k8: 8,
	k9: 9,
	k10: 10,
	k11: 11,
	k12: 12,
	k13: 13,
	k14: 14,
	k15: 15,
};
check("sixteen slots", wide16.k0 === 0 && wide16.k7 === 7 && wide16.k15 === 15);

const wide32 = {
	k0: 0,
	k1: 1,
	k2: 2,
	k3: 3,
	k4: 4,
	k5: 5,
	k6: 6,
	k7: 7,
	k8: 8,
	k9: 9,
	k10: 10,
	k11: 11,
	k12: 12,
	k13: 13,
	k14: 14,
	k15: 15,
	k16: 16,
	k17: 17,
	k18: 18,
	k19: 19,
	k20: 20,
	k21: 21,
	k22: 22,
	k23: 23,
	k24: 24,
	k25: 25,
	k26: 26,
	k27: 27,
	k28: 28,
	k29: 29,
	k30: 30,
	k31: 31,
};
check("thirty-two slots", wide32.k0 === 0 && wide32.k16 === 16 && wide32.k31 === 31);

console.log("object-slot-coallocation PASS 15/15");
