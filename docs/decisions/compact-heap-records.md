# Compact ordinary heap records

Ordinary objects keep a stable identity cell while a shared shape describes the
property contract. On a 64-bit host the cell starts with a 16-byte header, then
an eight-byte prototype word and a variable payload. Exotic objects embed their
prototype, fields pointer, and overflow pointer after the same header. An
ordinary object acquires that sidecar only when its fields or dictionary state
can no longer live in the cell. The prototype remains per object because
`Object.setPrototypeOf` can change it without changing property order or moving
the object.

## Field layout

Every shaped property occupies one tagged `MalValue` field, and its slot is its
property ordinal. NaN boxing already stores doubles unboxed and int32 values
inline, so field reads never decode a representation and a shape guard licenses
one load at `fields[slot]`.

An earlier layout packed int32, double and raw-pointer fields into physical
variants of each shape. However, every cache hit then decoded a four-way field
token, the decode was too large to inline at most sites, and a representation
change repacked the payload and swapped the object's shape. Uniform slots made the
native self-compile about 1.6% faster. A drawback is that int32-heavy records
grow four bytes per field.

Representation knowledge belongs in facts about a shape's fields rather than in
their storage, so a new fact never needs a new physical layout or a migration.

## Private elements

A shaped object keeps private fields and brand markers in its shape, keyed by
their private name with writable-only attributes. Public symbols still move the
object to dictionary mode, so a symbol key in a shape is always private:
reflection, copying, and serialization skip non-string shape keys, and
integrity levels leave them unchanged. Dictionary mode moves private elements
into the table with the same descriptor. Keeping them in a private-only table
cost every instance a storage sidecar and a table, which made constructing a
class with three private fields 3.6 times slower than with public ones.

A private name's hint is its last slot plus one. A read validates the hint
against the receiver's own shape, so subclasses that add fields after the base
class's private fields share one hint. A run of private fields installs through a
cached source-to-final shape pair.

## Identity-preserving changes

A write changes only the payload. Adding a property, changing attributes,
defining an accessor, or deleting a property uses the existing shape or
dictionary operation. Those changes may allocate a sidecar or field buffer but
never replace the identity cell. Prototype changes update its prototype word or
sidecar and invalidate dependent caches.

Tagged ordinary objects derive their inline bound from their original slot
capacity on first growth, avoiding allocator-size queries for objects that never
grow. Embedded objects and separately owned fields cannot infer an inline bound.
Spare capacity remains invisible to reflection and tracing until each new field
is initialized and its shape is published.

## Compiled access

Inline caches retain the shape and slot. A numeric read region can carry its
result through pure arithmetic and commit through a guarded field store without
boxing in between. It runs the original operations when admission or a Number
check fails. This includes retained records whose identity crosses functions and
survives reflection.

The companion native fixture exercises number round trips, GC tracing,
descriptor reflection, mutation, accessors, deletion, prototype changes,
integrity levels, and identity after externalization in compiled and interpreted
execution. The `materialized-record-graph` benchmark retains an object graph
across function calls and traversals, so its records cannot be removed by scalar
replacement.
