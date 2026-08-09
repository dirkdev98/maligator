# temporal_rs C bindings

These headers are the generated C bindings shipped by `temporal_capi` 0.2.6.
They are vendored because Maligator's C runtime is compiled independently from
Cargo and released builds cannot refer to a developer's Cargo registry. The
implementation remains the locked Cargo dependency; do not edit generated
headers by hand. Regenerate this directory from `temporal_capi/bindings/c` when
upgrading the crate.

`temporal_capi` and `temporal_rs` are dual-licensed under Apache-2.0 or MIT; the
upstream license texts are included beside this file.
