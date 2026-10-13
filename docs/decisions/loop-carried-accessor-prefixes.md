# Loop-carried read-accessor prefixes

Core read-accessor expansion can retain a successful ordinary-data/private-data
prefix through one canonical natural loop. The bounded plan records receiver and
private-name identities, named field and method paths, invariant numeric guards,
retained boxed values, and instructions that invalidate the relationships. Nested
or irreducible loops and unsupported accesses retain ordinary expansion.

Admission is lazy at the original read. The loop carries a readiness flag, a
runtime service generation, and boxed references consumed by the retained path
through SSA block parameters. Method, receiver, and intermediate field proofs
remain admission facts; their values become payload only when an ordinary
program use needs them. An unsuccessful probe enters the original region for the current
iteration. That continuation clears readiness and preserves already appended
output; it never restarts the materializer. Indexed probes remain in every
successful iteration and reload current elements and backing storage.

A selected contained-fresh-array push can preserve source relationships when its
receiver is a distinct local allocation that dominates the loop. The producer
proves the actual builtin identity and rejects unsupported uses, including mixed
aliases that lose allocation provenance. Returning the array, or embedding it in
a final return value after its last selected write, does not expose it during
those writes. This exception applies to the selected write's receiver; generic
calls and other writes retain their original effects and invalidate readiness.
The helper's throwing and collecting obligations remain in Core and target root
plans.

The VM service generation advances before safepoint service. A poll that performs
no service leaves it unchanged. The cached path checks that generation before
using retained relationships, so service forces lazy re-admission on the next
iteration. Existing boxed-value root storage preserves all retained references;
no raw backing address survives the boundary. The generation saturates at the
largest exactly represented JavaScript integer, after which comparisons always
miss. Poll placement, collection pacing, and cancellation checks are unchanged.

The expansion cost includes its second successful path, generic continuation,
SSA edge and root traffic, numeric guards, and bounded loop analysis. Candidate
priority accounts for prefix probes removed after admission, less retained-root
and generation-check costs. Loops with possible invalidators receive no extra
reuse benefit in that estimate. Existing priority classes and global budgets are
unchanged; the renderer only lowers explicit Core operations.
