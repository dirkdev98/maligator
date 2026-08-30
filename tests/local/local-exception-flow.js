const events = [];

function caught(value) {
	try {
		events.push("try");
		throw value;
	} catch (error) {
		events.push(`catch:${error}`);
		return error;
	} finally {
		events.push("finally");
	}
}

function nested(value) {
	try {
		try {
			throw value;
		} finally {
			events.push("inner-finally");
		}
	} catch (error) {
		events.push(`outer-catch:${error}`);
		return error;
	}
}

console.log(caught(42));
console.log(nested("value"));
const marker = new Error("marker");
const stackBeforeThrow = marker.stack;
console.log(caught(marker) === marker, marker.stack === stackBeforeThrow);
console.log(events.join(","));
