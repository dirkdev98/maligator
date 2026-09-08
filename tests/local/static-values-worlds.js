function check(condition, message) {
	if (!condition) throw new Error(message);
}
const other = $262.createRealm().global;
const local = [1, 2];
const foreign = new other.Array(1, 2);
check(other.Array.prototype.includes.call(local, 2), "borrowed foreign method");
check(Array.prototype.includes.call(foreign, 2), "borrowed local method");
check(Object.getPrototypeOf(foreign) === other.Array.prototype, "foreign prototype");
globalThis.escapedStaticReceiver = [1];
eval("escapedStaticReceiver.includes = function () { return 'eval-shadow'; }");
check(escapedStaticReceiver.includes(1) === "eval-shadow", "eval descendant shadow");
check([1].includes(1), "unrelated literal remains correct");
const collator = new Intl.Collator("en");
const compare = collator.compare;
check(compare === collator.compare && compare("a", "b") < 0, "cached accessor result");
check(compare !== new Intl.Collator("en").compare, "per-instance bound identity");
console.log("static value world boundaries passed");
