function check(label, condition) {
	if (!condition) throw new Error(label);
}

const negativeZero = -0;
const nan = 0 / 0;
const infinity = 1 / 0;

check("negative zero", Object.is(negativeZero, -0) && 1 / negativeZero === -Infinity);
check("NaN", Number.isNaN(nan));
check("infinity", infinity === Infinity);
check("loose Boolean/Number", false == 0 && true == 1);
check("loose null/undefined", null == undefined);
check("strict remains strict", false !== 0);
check("constant branch", (7 % 3 === 1 ? 20 : 99) === 20);

console.log("constant-fold PASS 7/7");
