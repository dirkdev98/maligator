function deletedVariable() {
	return eval(`
		var removed = 1;
		var read = function () { return removed; };
		var deleted = delete removed;
		var failure;
		try { read(); } catch (error) { failure = error.name; }
		[deleted, typeof removed, failure];
	`);
}

function deletedFunction() {
	return eval(`
		function removedFunction() {}
		var read = function () { return removedFunction; };
		var deleted = delete removedFunction;
		var failure;
		try { read(); } catch (error) { failure = error.name; }
		[deleted, typeof removedFunction, failure];
	`);
}

globalThis.evalFallbackValue = 42;
function globalFallback() {
	return eval(`
		var evalFallbackValue = 1;
		delete evalFallbackValue;
		[evalFallbackValue, typeof evalFallbackValue];
	`);
}

function assignAfterDeletion() {
	return eval(`
		var assignedAfterDelete = 1;
		delete assignedAfterDelete;
		assignedAfterDelete = 8;
		[assignedAfterDelete, typeof assignedAfterDelete];
	`);
}

function preserveCallerBinding() {
	var retained = 3;
	return eval("[delete retained, retained]");
}

const results = [
	deletedVariable(),
	deletedFunction(),
	globalFallback(),
	assignAfterDeletion(),
	globalThis.assignedAfterDelete,
	preserveCallerBinding(),
];
delete globalThis.evalFallbackValue;
delete globalThis.assignedAfterDelete;
console.log(JSON.stringify(results));
