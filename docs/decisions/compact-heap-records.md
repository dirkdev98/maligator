# Compact ordinary heap records

Ordinary objects keep a stable identity cell while a shared shape describes the
property contract. On a 64-bit host the cell starts with a 16-byte header, then
an eight-byte prototype word and a variable payload. Exotic objects embed their
prototype, fields pointer, and overflow pointer after the same header. An
ordinary object acquires that sidecar only when its fields or dictionary state
can no longer live in the cell. The prototype remains per object because
`Object.setPrototypeOf` can change it without changing property order or moving
the object.

## Logical and physical layouts

The canonical shape owns property names, insertion order, attributes, and
structural transitions. Physical variants share that logical identity and give
each ordinal a field token containing an offset and one representation:

| Representation | Payload        | Read as JavaScript value                         |
| -------------- | -------------- | ------------------------------------------------ |
| `I32`          | Four bytes     | Number with the same integer value               |
| `F64`          | Eight bytes    | Number, retaining negative zero and NaN behavior |
| `HEAP`         | Native pointer | Tagged heap value                                |
| `TAGGED`       | `MalValue`     | Unchanged value                                  |

Eight-byte fields precede four-byte fields in the payload. Property enumeration
uses logical ordinals, never physical order. The descriptor also carries masks
for raw heap pointers and tagged fields; tracing reads each according to that
map. A canonical shape stores all fields as tagged values. Physical variants
are bounded to eight per logical shape, and the preferred layout joins observed
representations so recurring constructor values converge instead of creating
unbounded variants. A two-field record with a tagged field uses the canonical
layout when packing cannot shrink its allocation class.

## Identity-preserving changes

A write that fits its field changes only the payload. A representation mismatch
selects a widened physical variant, stages the old JavaScript values, repacks
the payload, and publishes the new shape last. It reuses spare capacity in the
original size class when possible; otherwise it externalizes field storage.
Adding a property, changing attributes, defining an accessor, or deleting a
property returns to canonical tagged storage before the existing shape or
dictionary operation. Those changes may allocate a sidecar or field buffer but
never replace the identity cell. Prototype changes update its prototype word
or sidecar and invalidate dependent caches.

The allocator's charged size, rather than the requested payload size, determines
whether in-place repacking fits. Raw pointers in compact fields receive the same
card, SATB, and mark treatment as tagged references. Stack materialization
copies the original cell-capacity bound so later widening cannot overrun it.
Tagged ordinary objects derive that bound from their original slot capacity on
first growth, avoiding allocator-size queries for objects that never grow.
Embedded objects and separately owned fields cannot infer an inline bound.
When adding a property requires canonical storage, existing typed fields decode
directly into the final geometrically sized buffer, avoiding an exact-size
allocation followed by growth.
If the tagged prefix and new properties fit the original cell, conversion stages
the overlapping fields before copying them back. Spare capacity remains invisible
to reflection and tracing until each new field is initialized and its shape is
published.

## Compiled access

Inline caches retain both logical property position and the physical field
token. A shape guard licenses direct typed reads and writes; the generic path
uses the same token and reboxes values for reflection. Shape changes invalidate
the old guard. Store caches can promote another physical variant of the same
logical shape using that variant's field token; an attribute change has a
different logical shape and misses the guard. A numeric read region can carry
its result through pure arithmetic and commit through a guarded field store
without boxing. It runs the original operations when admission or
representation checks fail. This includes retained records whose identity
crosses functions and survives reflection and generalization.

The companion native fixture exercises typed fields, GC tracing, descriptor
reflection, mutation, accessors, deletion, prototype changes, integrity levels,
and identity after externalization in compiled and interpreted execution. The
`materialized-record-graph` benchmark retains an object graph across function
calls and traversals, so its records cannot be removed by scalar replacement.
