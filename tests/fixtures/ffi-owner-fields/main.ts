/* oxlint-disable no-console -- The fixture reports observable resource owner lifetimes. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/owner_fields";
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(action: () => unknown, message: string): void {
	let caught = false;
	try {
		action();
	} catch (error) {
		caught = error instanceof TypeError;
	}
	check(caught, message);
}
for (const make of [c.owner_result_new, c.newResultAsync]) {
	const parent = await make(10);
	const first = parent.first!;
	const second = parent.second!;
	check(
		parent.first === first &&
			first.next === second &&
			c.owner_child_alias(first) === first,
		"field views and C aliases preserve canonical identity",
	);
	check(
		parent.empty === null && c.owner_child_value(parent.library!) === 777,
		"nullable and library-lifetime resource fields map explicitly",
	);
	rejects(
		() => c.owner_child_free(first),
		"a destroy binding cannot free an owner-bound child",
	);
	let asyncRejected = false;
	try {
		await c.destroyChildAsync(first);
	} catch (error) {
		asyncRejected = error instanceof TypeError;
	}
	check(
		asyncRejected && c.owner_child_value(first) === 10,
		"worker destroy admission preserves the parent-owned child",
	);
	check(
		c.owner_child_visit(first, () =>
			rejects(() => parent[Symbol.dispose](), "child C calls pin the parent"),
		) === 10,
		"reentrant child calls retain their owning resource",
	);
	first[Symbol.dispose]();
	check(
		c.owner_child_value(second) === 11 && c.owner_child_value(parent.first) === 10,
		"disposing a borrowed view preserves the container's resources",
	);
	const library = parent.library!;
	parent[Symbol.dispose]();
	rejects(
		() => c.owner_child_value(second),
		"closed parents invalidate saved child handles",
	);
	check(
		c.owner_child_value(library) === 777,
		"library-lifetime fields remain independent of parent disposal",
	);
	second[Symbol.dispose]();
	library[Symbol.dispose]();
}
function childWithoutParentReference() {
	return c.owner_result_new(20).first!;
}
const before = c.owner_result_destroyed();
function checkSavedChild() {
	const saved = childWithoutParentReference();
	collect();
	check(
		c.owner_result_destroyed() === before && c.owner_child_value(saved) === 20,
		"a saved child keeps its owning result reachable",
	);
}
Reflect.apply(checkSavedChild, undefined, []);
collect();
check(
	c.owner_result_destroyed() > before,
	"collecting the last child releases the owning result",
);
const parent = c.owner_result_new(30);
const child = parent.first!;
const pending = c.waitChildAsync(child);
rejects(() => parent[Symbol.dispose](), "worker child calls pin their parent");
rejects(() => parent.second, "parent field reads cannot race with child workers");
rejects(
	() => c.owner_child_alias(child)![Symbol.dispose](),
	"aliases cannot bypass an active worker pin",
);
c.owner_child_release();
check((await pending) === 30, "worker retains child storage through completion");
c.owner_wait_reset();
const parentPending = c.waitResultAsync(parent);
rejects(() => child.next, "saved child fields cannot race with a parent worker");
c.owner_child_release();
check((await parentPending) === 30, "parent workers retain their children");
parent[Symbol.dispose]();
const viewOwner = c.owner_result_new(71);
const base = c.owner_result_base(viewOwner)!;
Object.freeze(base);
const refined = viewOwner.first!;
check(
	refined === base && c.owner_child_value(refined.next!) === 72,
	"frozen base-first wrappers expose resource fields after view refinement",
);
viewOwner[Symbol.dispose]();
rejects(() => c.owner_base_value(base), "base views enforce the child's owner lifetime");
const unreadable = c.owner_unreadable_base()!;
const refinedBorrow = c.owner_child_from_base(unreadable)!;
check(refinedBorrow === unreadable, "borrowed refinement preserves the base wrapper");
rejects(
	() => refinedBorrow.next,
	"actual ownership is proved before reading a derived resource field",
);
refinedBorrow[Symbol.dispose]();
c.owner_unreadable_release();
const unclaimedRoot = c.owner_result_new(74);
const rawLast = c.owner_result_last_base(unclaimedRoot)!;
const refinedNull = c.owner_child_from_base(rawLast)!;
rejects(
	() => refinedNull.next,
	"NULL resource fields still require an actual destruction root",
);
check(
	unclaimedRoot.second === refinedNull && refinedNull.next === null,
	"owner adoption validates nullable fields on refined views",
);
unclaimedRoot[Symbol.dispose]();
let loan: c.OwnerChild | undefined;
c.owner_lend_child((lent) => {
	loan = lent!;
	const alias = c.owner_result_alias(loan);
	c.owner_child_visit(loan, () =>
		rejects(() => alias.first, "a pinned loan cannot acquire an owner"),
	);
	alias[Symbol.dispose]();
});
rejects(
	() => c.owner_child_value(loan!),
	"failed adoption does not extend callback loans",
);
let nestedLoan: c.OwnerChild | undefined;
let escapedWorker: Promise<number> | undefined;
c.owner_lend_result((lent) => {
	nestedLoan = lent.first!;
	escapedWorker = c.waitChildAsync(nestedLoan);
	rejects(
		() => c.owner_visit_result(() => nestedLoan!),
		"child results cannot escape a callback loan's owner",
	);
});
let workerLoanRejected = false;
try {
	await escapedWorker;
} catch (error) {
	workerLoanRejected = error instanceof TypeError;
}
check(workerLoanRejected, "child workers cannot escape a callback loan's owner");
rejects(
	() => c.owner_child_value(nestedLoan!),
	"saved children expire with a callback's parent loan",
);
const oldReuse = c.owner_result_reused(81),
	oldView = oldReuse.first!;
oldReuse[Symbol.dispose]();
const newReuse = c.owner_result_reused(82),
	newView = newReuse.first!;
check(
	newView !== oldView && c.owner_child_value(newView) === 82,
	"reused C addresses acquire a new owner lifetime",
);
rejects(
	() => c.owner_child_value(oldView),
	"stale aliases cannot acquire a reused address's new lifetime",
);
newReuse[Symbol.dispose]();
for (const register of [
	c.owner_watch_child,
	c.watchChildAsync,
	c.owner_replace_child,
	c.replaceChildAsync,
]) {
	const registrationOwner = c.owner_result_new(73),
		registrationChild = registrationOwner.first!;
	const calls = c.owner_watch_calls();
	let rejected = false;
	try {
		await Promise.resolve(register(registrationChild, () => {}));
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && c.owner_watch_calls() === calls,
		"kept child registrations fail before C publication",
	);
	await Promise.resolve(register(registrationChild, null));
	check(
		c.owner_watch_calls() === calls + 1,
		"null callback unregistration remains available",
	);
	registrationOwner[Symbol.dispose]();
}
const independent = c.owner_child_new(40)!;
const conflicting = c.owner_result_alias(independent);
rejects(
	() => conflicting.first,
	"owner fields cannot acquire independently owned resources",
);
conflicting[Symbol.dispose]();
independent[Symbol.dispose]();
const original = c.owner_result_new(41);
const shared = original.first!;
const other = c.owner_result_alias(shared);
rejects(() => other.first, "canonical children reject conflicting live owners");
other[Symbol.dispose]();
check(
	c.owner_child_value(shared) === 41,
	"failed owner adoption preserves the original relation",
);
original[Symbol.dispose]();
for (const invoke of [c.owner_result_callback, c.resultCallbackAsync]) {
	const oldResults = c.owner_result_destroyed(),
		oldChildren = c.owner_child_destroyed();
	const marker = new Error("result marker");
	let caught: unknown;
	try {
		await invoke(() => {
			throw marker;
		});
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker &&
			c.owner_result_destroyed() === oldResults + 1 &&
			c.owner_child_destroyed() === oldChildren + 2,
		"pending callback failures destroy unobserved compound results",
	);
}
for (const keep of [c.owner_keep_child, c.keepChildAsync]) {
	const owner = c.owner_result_new(60),
		borrowed = owner.first!;
	await Promise.resolve(keep(() => borrowed));
	collect();
	check(
		c.owner_kept_child_value() === 60,
		"registered callback results retain their child and owner",
	);
	rejects(
		() => owner[Symbol.dispose](),
		"a child callback-result lease retains its owner",
	);
	rejects(() => borrowed[Symbol.dispose](), "leased child views stay open");
	c.owner_release_child();
	owner[Symbol.dispose]();
}
const document = c.owner_result_nodes(90),
	unclaimed = c.owner_leaf_alias(document)!;
rejects(() => unclaimed.next, "unclaimed descendants require a proven owning root");
const leaf = document.nodes!,
	sibling = leaf.next!;
check(
	leaf === unclaimed && c.owner_leaf_value(sibling) === 91,
	"destructorless descendants borrow a common root",
);
check(
	c.owner_leaf_visit(leaf, () =>
		rejects(
			() => document[Symbol.dispose](),
			"descendant calls pin the destruction root",
		),
	) === 90,
	"borrowed descendants retain the document during C callbacks",
);
c.owner_wait_reset();
const leafPending = c.waitLeafAsync(sibling);
rejects(() => document[Symbol.dispose](), "descendant workers pin the destruction root");
c.owner_child_release();
check((await leafPending) === 91, "destructorless descendant workers complete safely");
check(
	c.owner_leaf_results((index) => {
		if (index === 1)
			rejects(
				() => document[Symbol.dispose](),
				"descendant callback results lease the destruction root",
			);
		return leaf;
	}) === 90,
	"destructorless callback results retain their root until C returns",
);
const oldLeaves = c.owner_leaf_destroyed();
leaf[Symbol.dispose]();
check(
	c.owner_leaf_value(sibling) === 91 && c.owner_leaf_value(document.nodes!) === 90,
	"closing a destructorless view preserves sibling resources",
);
document[Symbol.dispose]();
check(
	c.owner_leaf_destroyed() === oldLeaves + 2,
	"only the owning destructor releases descendants",
);
rejects(
	() => c.owner_leaf_value(sibling),
	"destructorless descendants expire with their root",
);
console.log("owner fields passed");
