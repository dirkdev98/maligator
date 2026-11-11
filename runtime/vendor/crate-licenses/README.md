# Crate license texts

Some crates in `runtime/rust/Cargo.lock` declare a license expression but publish no
license file. Each directory holds the `LICENSE` of that crate's source repository,
which the notices generator uses in place of a file from the crate:

- `alloc-stdlib`: <https://github.com/dropbox/rust-alloc-no-stdlib>
- `blake2b_simd`: <https://github.com/oconnor663/blake2_simd>
