/* oxlint-disable no-console -- The fixture reports observable resource owner lifetimes. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/owner_fields";
import { createWorkerUrl, Worker } from "maligator:workers";
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
	const registrationOwner = c.owner_result_new(73);
	const child = registrationOwner.first!;
	const calls = c.owner_watch_calls();
	let oldCalls = 0,
		newCalls = 0;
	await Promise.resolve(
		register(child, () => {
			oldCalls++;
		}),
	);
	check(
		c.owner_fire_child(child) === 73 && oldCalls === 1,
		"retained callbacks fire after registration returns",
	);
	check(
		registrationOwner.first === child && c.owner_child_alias(child) === child,
		"registration leases preserve fields and aliases",
	);
	rejects(() => child[Symbol.dispose](), "a registration protects its child view");
	rejects(
		() => registrationOwner[Symbol.dispose](),
		"a registration protects its destruction root",
	);
	rejects(
		() => c.owner_result_destroy(registrationOwner),
		"a destroy binding cannot bypass registration leases",
	);
	await Promise.resolve(
		register(child, () => {
			newCalls++;
		}),
	);
	c.owner_fire_child(child);
	check(
		oldCalls === 1 && newCalls === 1,
		"replacement retires the previous callback and its input leases",
	);
	await Promise.resolve(register(child, null));
	c.owner_fire_child(child);
	check(
		c.owner_watch_calls() === calls + 3 && newCalls === 1,
		"null unregistration releases the retained input chain",
	);
	child[Symbol.dispose]();
	registrationOwner[Symbol.dispose]();
}
{
	const root = c.owner_result_new(74),
		child = root.first!;
	const subscribe = child.subscribe!;
	let calls = 0;
	subscribe(child, () => {
		calls++;
	});
	c.owner_fire_child(child);
	check(
		calls === 1 && root.first === child,
		"owner-bound callable registration keeps fields readable",
	);
	rejects(
		() => root[Symbol.dispose](),
		"a saved callable's registration protects its root",
	);
	subscribe(child, null);
	root[Symbol.dispose]();
	rejects(
		() => subscribe(child, null),
		"a saved callable expires after unregistration and root disposal",
	);
}
{
	const root = c.owner_result_new(75),
		first = root.first!,
		second = root.second!;
	let firstCalls = 0,
		secondCalls = 0;
	c.owner_replace_child(first, () => {
		firstCalls++;
	});
	c.owner_replace_child(second, () => {
		secondCalls++;
	});
	c.owner_replace_child(c.owner_child_alias(first)!, () => {
		firstCalls += 10;
	});
	c.owner_fire_child(first);
	c.owner_fire_child(second);
	check(
		firstCalls === 10 && secondCalls === 1,
		"siblings have independent replacement keys through aliases",
	);
	c.owner_replace_child(first, null);
	first[Symbol.dispose]();
	rejects(
		() => root[Symbol.dispose](),
		"a sibling registration still protects the common root",
	);
	const marker = new Error("registered callback marker");
	c.owner_replace_child(second, () => {
		throw marker;
	});
	let failure: unknown;
	try {
		c.owner_fire_child(second);
	} catch (error) {
		failure = error;
	}
	check(failure === marker, "callback exceptions preserve registration ownership");
	c.owner_replace_child(second, null);
	root[Symbol.dispose]();
}
{
	const root = c.owner_result_new(76),
		child = root.first!;
	c.owner_watch_child(child, () => {
		c.owner_watch_child(child, null);
		rejects(
			() => root[Symbol.dispose](),
			"a retiring callback protects its root through its active frame",
		);
	});
	c.owner_fire_child(child);
	root[Symbol.dispose]();
}
for (const inputFirst of [false, true]) {
	const root = c.owner_result_new(88),
		child = root.first!;
	const subscribe = child.subscribe!;
	c.owner_watch_child(child, () => {});
	c.owner_keep_child(() => child);
	rejects(
		() => root.first,
		"a result lease blocks fields while an input lease overlaps it",
	);
	if (inputFirst) {
		c.owner_watch_child(child, null);
		rejects(
			() => root.first,
			"retiring input leases preserves the result's field restriction",
		);
		rejects(() => subscribe(child, null), "result leases still block saved callables");
		check(
			c.owner_kept_child_value() === 88,
			"the remaining result lease preserves native storage",
		);
		c.owner_release_child();
	} else {
		c.owner_release_child();
		check(
			root.first === child,
			"input-only leases leave fields readable after result release",
		);
		rejects(
			() => root[Symbol.dispose](),
			"the remaining input lease still protects lifetime",
		);
		subscribe(child, null);
	}
	root[Symbol.dispose]();
}
for (const register of [c.owner_watch_input, c.watchInputAsync]) {
	const first = c.owner_result_new(77),
		second = c.owner_result_new(78);
	const input = [first.first!, second.first!];
	let calls = 0;
	await Promise.resolve(
		register(input, () => {
			calls++;
		}),
	);
	c.owner_fire_child(input[0]!);
	check(calls === 1, "compound registration inputs survive the C call");
	rejects(() => first[Symbol.dispose](), "compound inputs retain their first root");
	rejects(() => second[Symbol.dispose](), "compound inputs retain every root");
	await Promise.resolve(register(input, null));
	first[Symbol.dispose]();
	second[Symbol.dispose]();
}
for (const register of [c.owner_keep_input, c.keepInputAsync]) {
	for (const resultIndex of [0, 1]) {
		const roots = [c.owner_result_new(79), c.owner_result_new(80)];
		let caught = false;
		try {
			await Promise.resolve(
				register([roots[0]!.first!, roots[1]!.first!], () => roots[resultIndex]!.second!),
			);
		} catch (error) {
			caught = error instanceof TypeError;
		}
		check(
			caught && c.owner_kept_child_value() === -1,
			"registration results cannot lease a sibling from any retained input root",
		);
		c.owner_release_child();
		for (const root of roots) root[Symbol.dispose]();
	}
}
{
	const root = c.owner_result_new(81);
	c.owner_lend_result((loan) => {
		const calls = c.owner_watch_calls();
		rejects(
			() => c.owner_watch_input([root.first!, loan.first!], () => {}),
			"a later loan input rolls back earlier registration leases",
		);
		check(c.owner_watch_calls() === calls, "loan rejection occurs before C publication");
	});
	root[Symbol.dispose]();
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
const libraryParent = c.owner_result_new(100),
	program = libraryParent.library!;
rejects(
	() => c.owner_child_free(program),
	"destroy bindings cannot free library storage",
);
let libraryDestroyRejected = false;
try {
	await c.destroyChildAsync(program);
} catch (error) {
	libraryDestroyRejected = error instanceof TypeError;
}
check(
	libraryDestroyRejected && c.owner_child_value(program) === 777,
	"worker destroy admission preserves library storage",
);
const closeCalls = c.owner_watch_calls();
rejects(
	() => c.owner_close_child(program, () => {}),
	"close completion cannot release library storage",
);
let libraryCloseRejected = false;
try {
	await c.closeChildAsync(program, () => {});
} catch (error) {
	libraryCloseRejected = error instanceof TypeError;
}
check(
	libraryCloseRejected && c.owner_watch_calls() === closeCalls,
	"library close rejects before C entry",
);
const falseOwner = c.owner_result_alias(program);
rejects(() => falseOwner.first, "an owning field cannot shorten library lifetime");
falseOwner[Symbol.dispose]();
const separate = c.owner_child_new(101)!,
	falseLibrary = c.owner_result_library_alias(separate);
rejects(
	() => falseLibrary.library,
	"library lifetime cannot replace independent ownership",
);
falseLibrary[Symbol.dispose]();
separate[Symbol.dispose]();
for (const ownedAlias of [c.owner_library_owned, c.libraryOwnedAsync]) {
	let rejected = false;
	try {
		await Promise.resolve(ownedAlias());
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && c.owner_child_value(program) === 777,
		"owned aliases cannot acquire library resources",
	);
}
for (const callbackAlias of [c.owner_library_callback, c.libraryCallbackAsync]) {
	const marker = new Error("library callback marker");
	let caught: unknown;
	try {
		await Promise.resolve(
			callbackAlias(() => {
				throw marker;
			}),
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && c.owner_child_value(program) === 777,
		"unobserved aliases preserve library storage and the callback error",
	);
}
program[Symbol.dispose]();
rejects(c.owner_library_owned, "disposing a view preserves its native library claim");
const reopened = libraryParent.library!;
check(
	reopened !== program &&
		c.owner_child_alias(reopened) === reopened &&
		c.owner_child_value(reopened) === 777,
	"library fields reopen a canonical borrowed view",
);
reopened[Symbol.dispose]();
libraryParent[Symbol.dispose]();
for (let index = 0; index < c.owner_program_count() - 1; index++) {
	const container = c.owner_result_program(index),
		item = container.library!;
	check(
		c.owner_child_value(item) === 1000 + index,
		"library claims preserve distinct native resources through table growth",
	);
	item[Symbol.dispose]();
	container[Symbol.dispose]();
	rejects(() => c.owner_program_owned(index), "claims survive growth and view disposal");
}
const worker = new Worker(createWorkerUrl("./library-worker.ts", import.meta.url));
const workerResult = new Promise<unknown>((resolve) => {
	worker.port.onmessage = (event) => resolve(event.data);
});
worker.port.start();
await worker.ready;
worker.port.postMessage(c.owner_program_count() - 1);
check(
	(await workerResult) === 1000 + c.owner_program_count() - 1,
	"worker observed its native library resource",
);
await worker.terminate();
rejects(
	() => c.owner_program_owned(c.owner_program_count() - 1),
	"library claims outlive the VM that observed them",
);
for (let index = 0; index < c.owner_program_count(); index++)
	rejects(
		() => c.owner_program_owned(index),
		"growing the claim table preserves earlier resources",
	);
rejects(c.owner_library_owned, "claim growth preserves the original library resource");
const registrationWorker = new Worker(
	createWorkerUrl("./registration-worker.ts", import.meta.url),
);
const registrationWorkerResult = new Promise<unknown>((resolve) => {
	registrationWorker.port.onmessage = (event) => resolve(event.data);
});
registrationWorker.port.start();
const destroyedBeforeWorker = c.owner_result_destroyed();
await registrationWorker.ready;
registrationWorker.port.postMessage(91);
check((await registrationWorkerResult) === 91, "worker published a child registration");
await registrationWorker.terminate();
check(
	c.owner_result_destroyed() === destroyedBeforeWorker && c.owner_fire_all() === 91,
	"registration inputs survive their VM while C retains the callback",
);
c.owner_clear_watches();
check(
	c.owner_result_destroyed() === destroyedBeforeWorker + 1,
	"native release after worker teardown destroys the root once",
);
for (const invoke of [
	c.owner_alias_callback,
	c.aliasCallbackAsync,
	c.owner_alias_outputs,
	c.aliasOutputsAsync,
]) {
	for (const borrowed of [false, true]) {
		const parent = borrowed ? c.owner_result_new(93) : null;
		const child = parent === null ? c.owner_child_new(93)! : parent.first!;
		const before = c.owner_child_destroyed();
		const marker = new Error("owned alias callback marker");
		let caught: unknown;
		try {
			await Promise.resolve(
				invoke(child, () => {
					throw marker;
				}),
			);
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker &&
				c.owner_child_destroyed() === before &&
				c.owner_child_value(child) === 93,
			"abandoned aliases preserve existing ownership and the original exception",
		);
		if (parent !== null) parent[Symbol.dispose]();
		else child[Symbol.dispose]();
	}
}
for (const invoke of [c.owner_new_outputs, c.newOutputsAsync]) {
	const before = c.owner_child_destroyed();
	const marker = new Error("new alias callback marker");
	let caught: unknown;
	try {
		await Promise.resolve(
			invoke(94, () => {
				throw marker;
			}),
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && c.owner_child_destroyed() === before + 1,
		"unobserved return and out aliases destroy new storage once",
	);
	const result = await invoke(94, () => {});
	check(
		result.result === result.out,
		"observed aliases still share one canonical wrapper",
	);
	result.result![Symbol.dispose]();
}
const failNextCell = (
	globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
).__mal_fail_next_cell_allocation;
if (failNextCell !== undefined) {
	const before = c.owner_child_destroyed();
	let caught = false;
	try {
		c.owner_new_outputs(95, failNextCell);
	} catch (error) {
		caught = error instanceof Error && error.message === "Out of memory";
	}
	check(
		caught && c.owner_child_destroyed() === before + 1,
		"a failed first conversion cannot destroy an aliased output twice",
	);
}
for (const invoke of [c.owner_loan_owned, c.loanOwnedAsync]) {
	const before = c.owner_child_destroyed();
	const marker = new Error("expired loan marker");
	let caught: unknown;
	try {
		await Promise.resolve(
			invoke(() => {
				throw marker;
			}),
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && c.owner_child_destroyed() === before + 1,
		"an expired callback loan cannot suppress cleanup of transferred ownership",
	);
}
for (const kind of ["owned", "child", "new", "new-outputs"]) {
	c.owner_global_reset();
	const rootCount = c.owner_result_destroyed(),
		childCount = c.owner_child_destroyed();
	const abandonedWorker = new Worker(
		createWorkerUrl("./discard-worker.ts", import.meta.url),
	);
	const ready = new Promise<unknown>((resolve) => {
		abandonedWorker.port.onmessage = (event) => resolve(event.data);
	});
	abandonedWorker.port.start();
	await abandonedWorker.ready;
	abandonedWorker.port.postMessage(kind);
	check((await ready) === kind, "worker prepared its result after async admission");
	while (c.owner_global_started() === 0)
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
	await abandonedWorker.terminate();
	check(
		c.owner_result_destroyed() === rootCount + (kind === "child" ? 1 : 0) &&
			c.owner_child_destroyed() === childCount + (kind === "child" ? 2 : 1),
		"abandoned worker results distinguish known aliases from newly allocated storage",
	);
}
console.log("owner fields passed");
