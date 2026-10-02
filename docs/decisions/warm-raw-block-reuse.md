# Bounded reuse of empty RAW blocks

RAW storage belongs to an explicit owner. Its allocator may keep reusable
capacity after that owner frees a buffer, but this capacity is neither a GC root
nor live ownership. Repeated collection growth and clear/reinsert operations
benefit from reusing a size class without resetting and advising its block on
every last free.

Each size class keeps its current RAW bump block when its last live buffer is
freed. All handed-out cells, including the last one, remain on that block's
intrusive free list. The allocator consumes those cells before bumping or
claiming another block. Empty noncurrent blocks recycle immediately. There is
no second cache or owner-specific allocation policy.

This bounds the empty reserve to one 32 KiB block in each of 32 size classes:
at most 1 MiB of block capacity per heap. It does not promise a particular RSS
delta. Chunk mappings have their own granularity, native page advice is
advisory, and resident pages depend on OS pressure and allocation lifetimes.

## Major collection and pressure

Both full and incremental major sweeps trim empty current RAW blocks after all
managed block and large-object finalizers have completed. A block may have been
visited before the owner that frees its last buffer, so trimming only while
visiting RAW blocks would miss empty reserves. Minor collections leave eligible
reserves reusable. Completed incremental sweep calls do not trim twice.

If acquiring a new chunk fails, the allocator performs one bounded reserve trim
and uses an available recycled block before returning allocation failure. It
does not evict warm reserves on ordinary size-class misses or retry chunk
allocation repeatedly. Existing fallible RAW allocation rejection still occurs
before reuse, and failed growth preserves the old buffer.

Blocks retain their sweep epoch while recycled. That epoch describes traversal
and black-allocation survivor accounting, not recent use. No additional age
field or GC scheduling policy is introduced.

## Ownership and list invariants

A warm block remains RAW and unrecycled, has no live cells, and is the current
block for its class. It is linked exactly once in that class's partial list and
never simultaneously in the shared recycled-block list. Unlinking repairs both
neighbors before a block can change lists or kind.

RAW buffers are not scanned as managed cells. Preserving a buffer's stale bytes
does not retain its former members. With verification poisoning enabled, freed
RAW cells retained for reuse are poisoned after the intrusive pointer; the
pointer itself remains available to the allocator. Returned RAW storage is
uninitialized, as before. Heap teardown releases the chunks containing reserves
alongside all other heap chunks.

The same list rules apply on WASI, where recycling has no native madvise step.
Allocation and free remain mutator operations, and worker tracing does not
access these free lists.

## Accounting

Every successful RAW reuse pays the existing allocation charge, requests GC at
the existing threshold, and records an allocation through the existing profile
boundary. Freeing or trimming does not decrement cumulative allocation or alter
managed survivor accounting. The RAW/large-object admission threshold is
unchanged.

`raw_owned_bytes` counts only outstanding buffers. `raw_free_cell_bytes` counts
handed-out cells available for reuse, and `bump_free_bytes` includes unused bump
capacity. `raw_warm_block_bytes` reports the whole empty reserve, including
headers; it overlaps the latter capacity categories and must not be added to
them as another ownership total. Major trim transfers those blocks to
`recycled_block_bytes`. GC statistics expose this distinction in both live and
pre-teardown snapshots.

Trimming is bounded by the class count, but may group page-advice calls in the
last major slice. Throughput, pause tails and resident memory must be measured
together. This policy does not remove the largest size class's packing loss or
replace evidence for independent changes to large-buffer admission.

## Coverage

Allocator ABI fixtures exercise class boundaries, partial and full warm blocks,
partial-list neighbor removal, live-buffer preservation, reuse charging and GC
polling, poisoning, full/incremental major trimming and minor finalizers. They
also preserve explicit RAW-to-managed recycling on both sides of the sweep
cursor, large owners freed after RAW block traversal, shutdown with reserves,
and deterministic fallible allocation/growth and chunk-pressure recovery.
