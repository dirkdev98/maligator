// Inline-frame markers: trace/mid/top are each tiny single-return functions
// that the inliner collapses into the top level. The captured stack must still
// show one logical frame per inlined level, innermost first.
function trace() {
	return new Error("boom").stack;
}
function mid() {
	return trace();
}
function top() {
	return mid();
}
console.log(top());
