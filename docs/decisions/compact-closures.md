# Compact closures and native capture arguments

Closed source images carry a sorted, shared list of external lexical owners for
each function. The list includes requirements forwarded to descendant closures;
own activation and locally created iteration scopes are supplied at execution.
The analysis runs after function reachability and physical capture-slot compaction.
Runtime eval, host splicing, relocatable images, and dynamic scope keep the chain
representation. The portable wire loader does not trust native capture metadata.

A captured binding remains an atomic slot in its activation or iteration owner.
Siblings refer to the same owner and slot, while `ENV_COPY` supplies a new owner.
This groups shared cells without allocating a separate heap object per binding.
A closure with no external requirements retains no environment. A single owner
uses a tagged terminal reference without additional storage. Multiple owners
normally coallocate a flat vector with the function object; immutable owner identifiers
remain in shared function metadata. Creation resolves the vector once, including
transitive requirements. Construction scans active scopes once and merges the
sorted incoming and requested layouts. A missing owner conservatively retains the supplied
chain. Function properties, identity, construction, and generic call behavior
continue to belong to the original function object.

When the complete active chain already contains exactly the required compact
owners in reverse layout order, a closure can reuse that chain without allocating
a redundant vector. The check must reach null or the final tagged owner and rejects
extra, duplicated, reordered, dynamic, or vector scopes. Every retained scope is
required by the closure. In particular, a vector belonging to another function
object cannot be shared this way: retaining that function would also keep its
unrelated mutable properties alive.
Consecutive nonnegative owner chains cache their exact length in existing environment
padding. Together with the immutable sorted layout, this proves an exact match in
constant time; sparse and synthetic owner lists still use the complete traversal.

The vector owns selected binding storage, not the owners' lexical parent links.
Active interpreter, compiled, and suspended frames explicitly root their lexical
chains. After activation exit a compact owner's parent may be stale and must not
be traversed through a captured reference. Mapped arguments retain only their
parameter storage. The inline vector is not a GC allocation: root and SATB helpers
shade its containing function, and the function tracer shades the selected owners.
Tagged single-owner references shade the owner directly and never follow its parent.
Environment replacement and suspended-frame teardown use the same distinction.
Stores retain atomic access, the SATB old-value barrier, and the generational card
barrier on the real owning cell.

Native canonical and specialized entries resolve nonnegative external owner IDs
once per entry, using a known vector ordinal for one owner or one traversal for
multiple owners, then access slots directly. Certified entries avoid repeating
the runtime environment-policy lookup; certified empty closures need no incoming
environment root.
Certified owner layouts also prove that required owners exist, eliminating repeated
null checks around native slot operations. Unknown layouts keep the checked path.
An active local scope takes precedence; a mismatched layout uses general lookup.
Suspended entries rebuild those local
references from the restored environment before resume dispatch. Locally changing
iteration scopes keep dynamic lookup. Stable captures in eligible private helpers
instead become ordinary SSA arguments, allowing typed arguments and results across
the call boundary. Branches, loops, and switches preserve their SSA edges; handlers,
guard facts, dynamic scope, and uncertain initialization retain the generic path.

Specialized entries carry their own outgoing call plans. A bounded worklist follows
known closed singleton targets and derives argument representations from the caller
variant. Proven scalar results flow back to its callers. Canonical entries and other
variants keep their own plans, so a numeric invocation cannot cause an escaped
string or object invocation to unbox unchecked arguments. Unknown targets cross the
generic bridge. Captured mutable values retain their boxed result uncertainty.
Recursive result cycles start boxed and cannot create their own scalar proof.
At most four entries per function are admitted, subject to the existing generated
code and compiler work budgets; bodies above 512 instructions are excluded from
new downstream specialization. The artifact codec and merged-image relocation
preserve these entry-specific edges.

Private entry conversion does not replace observable closures. Calls whose identity,
arity, effects, or capture initialization are unproved use the canonical bridge.
TDZ sentinels never cross the ordinary argument ABI. The current physical retention
unit is a lexical owner, so closures can still retain unrelated live slots belonging
to the same owner. Persistently copying immutable bindings by value requires a
separate initialization and alias proof; the current by-value conversion applies
to private call arguments.
