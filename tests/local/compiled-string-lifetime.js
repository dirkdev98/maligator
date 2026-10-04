function check(condition) {
	if (!condition) throw new Error("compiled string lifetime mismatch");
}

const receiver = "latin-1-é";
const attribute = 'a"é';
check(receiver.bold() === "<b>latin-1-é</b>");
check(receiver.anchor(attribute) === '<a name="a&quot;é">latin-1-é</a>');
check(receiver[8] === "é");
check(receiver.charCodeAt(8) === 233);
check(attribute[2] === "é");
check(attribute.charCodeAt(2) === 233);
check({ [receiver]: 17 }[receiver] === 17);
check(new Map([[attribute, 23]]).get(attribute) === 23);
console.log("compiled-string-lifetime PASS");
