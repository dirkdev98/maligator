/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import * as c from "maligator:ffi/views";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(action: () => void, message: string): void {
	let refused = false;
	try {
		action();
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused, message);
}

const derived = c.views_open(7)!;
check(c.views_read(derived) === 7, "derived accepts base input");
check(c.views_read_middle(derived) === 7, "transitive views accept middle input");
const base = c.views_base(derived)!;
check(base === derived, "base result preserves identity");
c.views_visit(derived, (lent) => {
	check(lent === derived, "base callback preserves identity");
	refuses(() => lent[Symbol.dispose](), "view shares active-call pins");
});
check(c.views_read(base) === 7, "held view survives callback");
refuses(
	// @ts-expect-error Runtime conversion must also refuse a sibling without C evidence.
	() => c.views_read_sibling(derived),
	"a shared base does not grant sibling access",
);
const sibling = c.views_sibling(derived)!;
check(
	Object.is(sibling, derived) && c.views_read_sibling(sibling) === 7,
	"C can supply sibling evidence",
);
base[Symbol.dispose]();
check(
	c.views_derived_closes() === 1 && c.views_base_closes() === 0,
	"base alias keeps derived owner",
);
refuses(() => c.views_read_derived(derived), "disposal closes all views");

const borrowed = c.views_pending(13)!;
// @ts-expect-error Runtime conversion must also refuse an unsupported downcast.
refuses(() => c.views_read_derived(borrowed), "base has no implicit downcast");
Object.freeze(borrowed);
const acquired = c.views_take_pending()!;
check(
	acquired === borrowed && c.views_read_derived(acquired) === 13,
	"base-first ownership preserves identity",
);
acquired[Symbol.dispose]();
check(c.views_derived_closes() === 2, "acquired ownership uses derived destructor");

const ownedBase = c.views_open_base(17)!;
c.views_nested(ownedBase, (middle) => {
	check(
		middle === ownedBase && c.views_read_middle(middle) === 17,
		"callback can refine a held view",
	);
});
ownedBase[Symbol.dispose]();
check(c.views_base_closes() === 1, "view evidence preserves existing owner policy");

const explicit = c.views_open(23)!;
c.views_close_base(c.views_base(explicit)!);
refuses(
	() => c.views_read_derived(explicit),
	"explicit base destruction closes derived alias",
);
check(c.views_base_closes() === 2, "explicit destructor runs once");

let escaped: c.ViewBase | undefined;
c.views_lend((outer) => {
	check(outer !== null, "library lends a base pointer");
	c.views_nested(outer, (inner) => {
		check(
			inner === outer && c.views_read(inner) === 29,
			"nested loan preserves identity",
		);
	});
	check(c.views_read(outer) === 29, "nested loan preserves outer lifetime");
	escaped = outer;
});
refuses(() => c.views_read(escaped!), "borrowed views expire together");
c.views_lend((next) => {
	check(next !== null && next !== escaped, "reused C addresses create a fresh loan");
	refuses(() => c.views_read(escaped!), "a new loan cannot revive an expired alias");
});

const caller = c.ViewCaller();
c.views_set(caller, 31);
check(
	c.views_caller_base(caller) === caller && c.views_read(caller) === 31,
	"caller storage shares views",
);
caller[Symbol.dispose]();
refuses(() => c.views_read(caller), "caller storage disposal closes views");
refuses(
	// @ts-expect-error Runtime branding must also refuse unrelated handle types.
	() => c.views_read(c.views_unrelated()!),
	"unrelated handles remain incompatible",
);
check(
	c.views_base_closes() === 2 && c.views_derived_closes() === 2,
	"each owner releases exactly once",
);
console.log("handle views passed");
