function forwardedProperty(value, fail) {
	try {
		if (fail) __mal_fail_next_cell_allocation();
		const record = { field: value };
		return record.field;
	} catch (error) {
		return error;
	}
}
function discardedRecord(value) {
	try {
		__mal_fail_next_cell_allocation();
		({ field: value });
		return false;
	} catch (error) {
		return error;
	}
}
const first = forwardedProperty(42, true);
console.log(first instanceof Error, first.message);
console.log(forwardedProperty(42, false));
const second = discardedRecord(42);
console.log(second === first, second.message);
