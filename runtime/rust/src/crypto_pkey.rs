//! Asymmetric keys for node:crypto: RSA, EC (P-256, P-384) and Ed25519 key
//! import/export in PEM, DER and raw JWK components, signing and verification.
//!
//! ring performs the cryptography; the PKCS#1/PKCS#8/SPKI/SEC1 framing is read
//! and written here because ring neither exports keys nor exposes RSA's CRT
//! components. Handles are boxed on the Rust side and released with
//! `mal_pkey_free`; no Rust panic or message string crosses the ABI.

use ring::rand::SystemRandom;
use ring::signature::{self, EcdsaKeyPair, Ed25519KeyPair, KeyPair, RsaKeyPair, UnparsedPublicKey};

pub const MAL_PKEY_OK: i32 = 0;
pub const MAL_PKEY_INVALID_KEY: i32 = 1;
pub const MAL_PKEY_UNSUPPORTED: i32 = 2;
pub const MAL_PKEY_ENCRYPTED: i32 = 3;
pub const MAL_PKEY_BAD_SIGNATURE: i32 = 4;
pub const MAL_PKEY_BUFFER_TOO_SMALL: i32 = 5;
pub const MAL_PKEY_NOT_PRIVATE: i32 = 6;
pub const MAL_PKEY_INVALID_ARGUMENT: i32 = 7;

const KIND_RSA: u32 = 1;
const KIND_EC_P256: u32 = 2;
const KIND_EC_P384: u32 = 3;
const KIND_ED25519: u32 = 4;

const FORMAT_PEM: u32 = 0;
const FORMAT_DER: u32 = 1;

const TYPE_PKCS1: u32 = 1;
const TYPE_PKCS8: u32 = 2;
const TYPE_SPKI: u32 = 3;
const TYPE_SEC1: u32 = 4;

const HASH_NONE: u32 = 0;
const HASH_SHA256: u32 = 1;
const HASH_SHA384: u32 = 2;
const HASH_SHA512: u32 = 3;

const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];

enum Material {
    Rsa {
        public: Vec<u8>,
        private: Option<(Vec<u8>, RsaKeyPair)>,
    },
    Ec {
        kind: u32,
        point: Vec<u8>,
        scalar: Option<Vec<u8>>,
    },
    Ed25519 {
        public: [u8; 32],
        seed: Option<[u8; 32]>,
    },
}

pub struct MalPkey {
    material: Material,
}

impl Drop for MalPkey {
    fn drop(&mut self) {
        match &mut self.material {
            Material::Rsa {
                private: Some((der, _)),
                ..
            } => der.iter_mut().for_each(|b| *b = 0),
            Material::Ec {
                scalar: Some(d), ..
            } => d.iter_mut().for_each(|b| *b = 0),
            Material::Ed25519 { seed: Some(s), .. } => s.iter_mut().for_each(|b| *b = 0),
            _ => {}
        }
    }
}

fn read_tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, mut rest) = rest.split_first()?;
    let length = if first < 0x80 {
        first as usize
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let mut length = 0usize;
        for &b in &rest[..count] {
            length = (length << 8) | b as usize;
        }
        if length < 0x80 || (count > 1 && rest[0] == 0) {
            return None;
        }
        rest = &rest[count..];
        length
    };
    if rest.len() < length {
        return None;
    }
    Some((tag, &rest[..length], &rest[length..]))
}

fn expect(input: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let (found, content, rest) = read_tlv(input)?;
    (found == tag).then_some((content, rest))
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = len.to_be_bytes();
        let skip = bytes.iter().take_while(|&&b| b == 0).count();
        out.push(0x80 | (bytes.len() - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

fn unsigned_integer(value: &[u8]) -> Vec<u8> {
    let trimmed = strip_zeros(value);
    let mut content = Vec::with_capacity(trimmed.len() + 1);
    if trimmed.is_empty() || trimmed[0] & 0x80 != 0 {
        content.push(0);
    }
    content.extend_from_slice(trimmed);
    tlv(0x02, &content)
}

fn strip_zeros(value: &[u8]) -> &[u8] {
    let skip = value.iter().take_while(|&&b| b == 0).count();
    &value[skip..]
}

fn bit_string(content: &[u8]) -> Vec<u8> {
    let mut body = vec![0u8];
    body.extend_from_slice(content);
    tlv(0x03, &body)
}

fn rsa_algorithm() -> Vec<u8> {
    seq(&[&tlv(0x06, OID_RSA), &[0x05, 0x00]])
}

fn ec_curve_oid(kind: u32) -> &'static [u8] {
    if kind == KIND_EC_P256 {
        OID_P256
    } else {
        OID_P384
    }
}

fn ec_algorithm(kind: u32) -> Vec<u8> {
    seq(&[&tlv(0x06, OID_EC), &tlv(0x06, ec_curve_oid(kind))])
}

fn ec_scalar_len(kind: u32) -> usize {
    if kind == KIND_EC_P256 {
        32
    } else {
        48
    }
}

fn curve_from_oid(oid: &[u8]) -> Option<u32> {
    match oid {
        OID_P256 => Some(KIND_EC_P256),
        OID_P384 => Some(KIND_EC_P384),
        _ => None,
    }
}

/// Algorithm OID plus its (possibly absent) parameters element.
fn read_algorithm(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let (oid, params) = expect(input, 0x06)?;
    Some((oid, params))
}

fn rsa_from_pkcs1_private(der: &[u8]) -> Result<Material, i32> {
    let pair = RsaKeyPair::from_der(der).map_err(|_| MAL_PKEY_INVALID_KEY)?;
    let public = pair.public().as_ref().to_vec();
    Ok(Material::Rsa {
        public,
        private: Some((der.to_vec(), pair)),
    })
}

fn rsa_from_pkcs1_public(der: &[u8]) -> Result<Material, i32> {
    let (body, rest) = expect(der, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (n, body) = expect(body, 0x02).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (_e, body) = expect(body, 0x02).ok_or(MAL_PKEY_INVALID_KEY)?;
    if !rest.is_empty() || !body.is_empty() || strip_zeros(n).is_empty() {
        return Err(MAL_PKEY_INVALID_KEY);
    }
    Ok(Material::Rsa {
        public: der.to_vec(),
        private: None,
    })
}

fn ec_from_parts(kind: u32, scalar: &[u8], point: &[u8]) -> Result<Material, i32> {
    let size = ec_scalar_len(kind);
    if scalar.len() > size || point.len() != 1 + 2 * size || point[0] != 4 {
        return Err(MAL_PKEY_INVALID_KEY);
    }
    let mut d = vec![0u8; size - scalar.len()];
    d.extend_from_slice(scalar);
    let alg = if kind == KIND_EC_P256 {
        &signature::ECDSA_P256_SHA256_ASN1_SIGNING
    } else {
        &signature::ECDSA_P384_SHA384_ASN1_SIGNING
    };
    EcdsaKeyPair::from_private_key_and_public_key(alg, &d, point, &SystemRandom::new())
        .map_err(|_| MAL_PKEY_INVALID_KEY)?;
    Ok(Material::Ec {
        kind,
        point: point.to_vec(),
        scalar: Some(d),
    })
}

/// SEC1 ECPrivateKey; `curve` comes from the PKCS#8 algorithm when wrapped.
fn ec_from_sec1(der: &[u8], curve: Option<u32>) -> Result<Material, i32> {
    let (body, _) = expect(der, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (version, body) = expect(body, 0x02).ok_or(MAL_PKEY_INVALID_KEY)?;
    if version != [1] {
        return Err(MAL_PKEY_INVALID_KEY);
    }
    let (scalar, mut body) = expect(body, 0x04).ok_or(MAL_PKEY_INVALID_KEY)?;
    let mut kind = curve;
    let mut point = None;
    while let Some((tag, content, rest)) = read_tlv(body) {
        match tag {
            0xa0 => {
                let (oid, _) = expect(content, 0x06).ok_or(MAL_PKEY_INVALID_KEY)?;
                let named = curve_from_oid(oid).ok_or(MAL_PKEY_UNSUPPORTED)?;
                if kind.is_some_and(|k| k != named) {
                    return Err(MAL_PKEY_INVALID_KEY);
                }
                kind = Some(named);
            }
            0xa1 => {
                let (bits, _) = expect(content, 0x03).ok_or(MAL_PKEY_INVALID_KEY)?;
                let (&unused, bits) = bits.split_first().ok_or(MAL_PKEY_INVALID_KEY)?;
                if unused != 0 {
                    return Err(MAL_PKEY_INVALID_KEY);
                }
                point = Some(bits);
            }
            _ => return Err(MAL_PKEY_INVALID_KEY),
        }
        body = rest;
    }
    let kind = kind.ok_or(MAL_PKEY_INVALID_KEY)?;
    // ring cannot derive the public point from the scalar alone.
    let point = point.ok_or(MAL_PKEY_UNSUPPORTED)?;
    ec_from_parts(kind, scalar, point)
}

fn ed25519_from_seed(seed: &[u8]) -> Result<Material, i32> {
    let pair = Ed25519KeyPair::from_seed_unchecked(seed).map_err(|_| MAL_PKEY_INVALID_KEY)?;
    let mut public = [0u8; 32];
    public.copy_from_slice(pair.public_key().as_ref());
    let mut owned = [0u8; 32];
    owned.copy_from_slice(seed);
    Ok(Material::Ed25519 {
        public,
        seed: Some(owned),
    })
}

fn parse_pkcs8(der: &[u8]) -> Result<Material, i32> {
    let (body, _) = expect(der, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (version, body) = expect(body, 0x02).ok_or(MAL_PKEY_INVALID_KEY)?;
    if version != [0] && version != [1] {
        return Err(MAL_PKEY_INVALID_KEY);
    }
    let (algorithm, body) = expect(body, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (private, _) = expect(body, 0x04).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (oid, params) = read_algorithm(algorithm).ok_or(MAL_PKEY_INVALID_KEY)?;
    match oid {
        OID_RSA => rsa_from_pkcs1_private(private),
        OID_EC => {
            let (curve, _) = expect(params, 0x06).ok_or(MAL_PKEY_INVALID_KEY)?;
            ec_from_sec1(
                private,
                Some(curve_from_oid(curve).ok_or(MAL_PKEY_UNSUPPORTED)?),
            )
        }
        OID_ED25519 => {
            let (seed, _) = expect(private, 0x04).ok_or(MAL_PKEY_INVALID_KEY)?;
            if seed.len() != 32 {
                return Err(MAL_PKEY_INVALID_KEY);
            }
            ed25519_from_seed(seed)
        }
        _ => Err(MAL_PKEY_UNSUPPORTED),
    }
}

fn parse_spki(der: &[u8]) -> Result<Material, i32> {
    let (body, _) = expect(der, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (algorithm, body) = expect(body, 0x30).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (bits, _) = expect(body, 0x03).ok_or(MAL_PKEY_INVALID_KEY)?;
    let (&unused, key) = bits.split_first().ok_or(MAL_PKEY_INVALID_KEY)?;
    if unused != 0 {
        return Err(MAL_PKEY_INVALID_KEY);
    }
    let (oid, params) = read_algorithm(algorithm).ok_or(MAL_PKEY_INVALID_KEY)?;
    match oid {
        OID_RSA => rsa_from_pkcs1_public(key),
        OID_EC => {
            let (curve, _) = expect(params, 0x06).ok_or(MAL_PKEY_INVALID_KEY)?;
            let kind = curve_from_oid(curve).ok_or(MAL_PKEY_UNSUPPORTED)?;
            if key.len() != 1 + 2 * ec_scalar_len(kind) || key[0] != 4 {
                // Compressed points would need decompression ring does not expose.
                return Err(if key.first() == Some(&4) {
                    MAL_PKEY_INVALID_KEY
                } else {
                    MAL_PKEY_UNSUPPORTED
                });
            }
            Ok(Material::Ec {
                kind,
                point: key.to_vec(),
                scalar: None,
            })
        }
        OID_ED25519 => {
            let public: [u8; 32] = key.try_into().map_err(|_| MAL_PKEY_INVALID_KEY)?;
            Ok(Material::Ed25519 { public, seed: None })
        }
        _ => Err(MAL_PKEY_UNSUPPORTED),
    }
}

fn parse_der(der: &[u8], key_type: u32, private: bool) -> Result<Material, i32> {
    match (key_type, private) {
        (TYPE_PKCS8, true) => parse_pkcs8(der),
        (TYPE_PKCS1, true) => rsa_from_pkcs1_private(der),
        (TYPE_SEC1, true) => ec_from_sec1(der, None),
        (TYPE_SPKI, false) => parse_spki(der),
        (TYPE_PKCS1, false) => rsa_from_pkcs1_public(der),
        // A public key may also be derived from private DER.
        (TYPE_PKCS8, false) => parse_pkcs8(der),
        (TYPE_SEC1, false) => ec_from_sec1(der, None),
        _ => Err(MAL_PKEY_INVALID_ARGUMENT),
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_decode(text: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    let mut padding = 0;
    for &c in text {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        if padding > 0 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn base64_encode_lines(data: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(data.len() * 4 / 3 + 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        encoded.push(B64[(n >> 18) as usize & 63]);
        encoded.push(B64[(n >> 12) as usize & 63]);
        encoded.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63]
        } else {
            b'='
        });
        encoded.push(if chunk.len() > 2 {
            B64[n as usize & 63]
        } else {
            b'='
        });
    }
    let mut out = Vec::with_capacity(encoded.len() + encoded.len() / 64 + 1);
    for line in encoded.chunks(64) {
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    out
}

struct PemBlock<'a> {
    label: &'a [u8],
    headers: bool,
    body: &'a [u8],
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn next_pem(text: &[u8]) -> Option<(PemBlock<'_>, &[u8])> {
    let start = find(text, b"-----BEGIN ")?;
    let after = &text[start + 11..];
    let label_end = find(after, b"-----")?;
    let label = &after[..label_end];
    let body_start = &after[label_end + 5..];
    let mut end_marker = b"-----END ".to_vec();
    end_marker.extend_from_slice(label);
    end_marker.extend_from_slice(b"-----");
    let end = find(body_start, &end_marker)?;
    let body = &body_start[..end];
    Some((
        PemBlock {
            label,
            headers: find(body, b":").is_some(),
            body,
        },
        &body_start[end + end_marker.len()..],
    ))
}

fn parse_pem(text: &[u8], private: bool) -> Result<Material, i32> {
    let mut rest = text;
    while let Some((block, after)) = next_pem(rest) {
        rest = after;
        let key_type = match block.label {
            b"PRIVATE KEY" => TYPE_PKCS8,
            b"RSA PRIVATE KEY" => TYPE_PKCS1,
            b"EC PRIVATE KEY" => TYPE_SEC1,
            b"ENCRYPTED PRIVATE KEY" => return Err(MAL_PKEY_ENCRYPTED),
            b"PUBLIC KEY" if !private => TYPE_SPKI,
            b"RSA PUBLIC KEY" if !private => TYPE_PKCS1,
            _ => continue,
        };
        if block.headers {
            return Err(MAL_PKEY_ENCRYPTED);
        }
        let mut der = base64_decode(block.body).ok_or(MAL_PKEY_INVALID_KEY)?;
        let private_block = !matches!(block.label, b"PUBLIC KEY" | b"RSA PUBLIC KEY");
        let result = parse_der(&der, key_type, private_block);
        der.iter_mut().for_each(|b| *b = 0);
        return result;
    }
    Err(MAL_PKEY_INVALID_KEY)
}

fn into_handle(material: Result<Material, i32>, out: *mut *mut MalPkey) -> i32 {
    match material {
        Ok(material) => {
            unsafe { *out = Box::into_raw(Box::new(MalPkey { material })) };
            MAL_PKEY_OK
        }
        Err(status) => status,
    }
}

unsafe fn slice<'a>(data: *const u8, len: usize) -> &'a [u8] {
    if data.is_null() || len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(data, len) }
    }
}

/// Imports a key; `private` selects createPrivateKey semantics. A public import
/// also accepts private input and keeps only its public half.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_import(
    data: *const u8,
    len: usize,
    format: u32,
    key_type: u32,
    private: bool,
    out: *mut *mut MalPkey,
) -> i32 {
    if out.is_null() {
        return MAL_PKEY_INVALID_ARGUMENT;
    }
    let input = unsafe { slice(data, len) };
    let material = match format {
        FORMAT_PEM => parse_pem(input, private),
        FORMAT_DER => parse_der(input, key_type, private),
        _ => Err(MAL_PKEY_INVALID_ARGUMENT),
    };
    let material = if private {
        material
    } else {
        material.map(public_half)
    };
    into_handle(material, out)
}

fn public_half(material: Material) -> Material {
    match material {
        Material::Rsa { public, .. } => Material::Rsa {
            public,
            private: None,
        },
        Material::Ec { kind, point, .. } => Material::Ec {
            kind,
            point,
            scalar: None,
        },
        Material::Ed25519 { public, .. } => Material::Ed25519 { public, seed: None },
    }
}

/// JWK import from raw big-endian components (absent ones have length 0):
/// RSA n,e,d,p,q,dp,dq,qi; EC x,y,d; Ed25519 x,d (in slots 0 and 2).
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_import_jwk(
    kind: u32,
    parts: *const *const u8,
    lens: *const usize,
    count: usize,
    private: bool,
    out: *mut *mut MalPkey,
) -> i32 {
    if out.is_null() || parts.is_null() || lens.is_null() || count < 8 {
        return MAL_PKEY_INVALID_ARGUMENT;
    }
    let part = |i: usize| unsafe { slice(*parts.add(i), *lens.add(i)) };
    let material = match kind {
        KIND_RSA => {
            let (n, e) = (part(0), part(1));
            if strip_zeros(n).is_empty() || strip_zeros(e).is_empty() {
                Err(MAL_PKEY_INVALID_KEY)
            } else if private {
                let fields: Vec<Vec<u8>> = (0..8).map(|i| unsigned_integer(part(i))).collect();
                if (2..8).any(|i| part(i).is_empty()) {
                    Err(MAL_PKEY_INVALID_KEY)
                } else {
                    let mut refs: Vec<&[u8]> = vec![&[0x02, 0x01, 0x00]];
                    refs.extend(fields.iter().map(|f| f.as_slice()));
                    rsa_from_pkcs1_private(&seq(&refs))
                }
            } else {
                rsa_from_pkcs1_public(&seq(&[&unsigned_integer(n), &unsigned_integer(e)]))
            }
        }
        KIND_EC_P256 | KIND_EC_P384 => {
            let size = ec_scalar_len(kind);
            let (x, y, d) = (part(0), part(1), part(2));
            if x.len() != size || y.len() != size {
                Err(MAL_PKEY_INVALID_KEY)
            } else {
                let point = [&[4u8][..], x, y].concat();
                if private {
                    if d.len() != size {
                        Err(MAL_PKEY_INVALID_KEY)
                    } else {
                        ec_from_parts(kind, d, &point)
                    }
                } else {
                    Ok(Material::Ec {
                        kind,
                        point,
                        scalar: None,
                    })
                }
            }
        }
        KIND_ED25519 => {
            let (x, d) = (part(0), part(2));
            match <[u8; 32]>::try_from(x) {
                Err(_) => Err(MAL_PKEY_INVALID_KEY),
                Ok(public) if !private => Ok(Material::Ed25519 { public, seed: None }),
                Ok(public) => {
                    if d.len() != 32 {
                        Err(MAL_PKEY_INVALID_KEY)
                    } else {
                        Ed25519KeyPair::from_seed_and_public_key(d, &public)
                            .map_err(|_| MAL_PKEY_INVALID_KEY)
                            .and_then(|_| ed25519_from_seed(d))
                    }
                }
            }
        }
        _ => Err(MAL_PKEY_UNSUPPORTED),
    };
    into_handle(material, out)
}

/// Generates an EC or Ed25519 key; ring has no RSA key generation.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_generate(kind: u32, out: *mut *mut MalPkey) -> i32 {
    if out.is_null() {
        return MAL_PKEY_INVALID_ARGUMENT;
    }
    let rng = SystemRandom::new();
    let pkcs8 = match kind {
        KIND_EC_P256 => {
            EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
        }
        KIND_EC_P384 => {
            EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P384_SHA384_ASN1_SIGNING, &rng)
        }
        KIND_ED25519 => Ed25519KeyPair::generate_pkcs8(&rng),
        _ => return MAL_PKEY_UNSUPPORTED,
    };
    match pkcs8 {
        Ok(document) => into_handle(parse_pkcs8(document.as_ref()), out),
        Err(_) => MAL_PKEY_UNSUPPORTED,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_pkey_free(key: *mut MalPkey) {
    if !key.is_null() {
        drop(unsafe { Box::from_raw(key) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_pkey_public(key: *const MalPkey, out: *mut *mut MalPkey) -> i32 {
    let Some(key) = (unsafe { key.as_ref() }) else {
        return MAL_PKEY_INVALID_ARGUMENT;
    };
    if out.is_null() {
        return MAL_PKEY_INVALID_ARGUMENT;
    }
    let material = match &key.material {
        Material::Rsa { public, .. } => Material::Rsa {
            public: public.clone(),
            private: None,
        },
        Material::Ec { kind, point, .. } => Material::Ec {
            kind: *kind,
            point: point.clone(),
            scalar: None,
        },
        Material::Ed25519 { public, .. } => Material::Ed25519 {
            public: *public,
            seed: None,
        },
    };
    into_handle(Ok(material), out)
}

#[no_mangle]
pub unsafe extern "C" fn mal_pkey_kind(key: *const MalPkey) -> u32 {
    match unsafe { key.as_ref() }.map(|k| &k.material) {
        Some(Material::Rsa { .. }) => KIND_RSA,
        Some(Material::Ec { kind, .. }) => *kind,
        Some(Material::Ed25519 { .. }) => KIND_ED25519,
        None => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_pkey_is_private(key: *const MalPkey) -> bool {
    match unsafe { key.as_ref() }.map(|k| &k.material) {
        Some(Material::Rsa { private, .. }) => private.is_some(),
        Some(Material::Ec { scalar, .. }) => scalar.is_some(),
        Some(Material::Ed25519 { seed, .. }) => seed.is_some(),
        None => false,
    }
}

fn rsa_public_parts(public: &[u8]) -> Option<(&[u8], &[u8])> {
    let (body, _) = expect(public, 0x30)?;
    let (n, body) = expect(body, 0x02)?;
    let (e, _) = expect(body, 0x02)?;
    Some((strip_zeros(n), strip_zeros(e)))
}

/// RSA private CRT components as stored (version, n, e, d, p, q, dp, dq, qi).
fn rsa_private_parts(der: &[u8]) -> Option<Vec<&[u8]>> {
    let (mut body, _) = expect(der, 0x30)?;
    let mut parts = Vec::with_capacity(9);
    for _ in 0..9 {
        let (value, rest) = expect(body, 0x02)?;
        parts.push(strip_zeros(value));
        body = rest;
    }
    Some(parts)
}

fn write_out(bytes: &[u8], out: *mut u8, cap: usize, written: *mut usize) -> i32 {
    if !written.is_null() {
        unsafe { *written = bytes.len() };
    }
    if out.is_null() || cap < bytes.len() {
        return MAL_PKEY_BUFFER_TOO_SMALL;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    MAL_PKEY_OK
}

/// RSA modulus length in bits, or 0 for other kinds.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_modulus_bits(key: *const MalPkey) -> u32 {
    let Some(Material::Rsa { public, .. }) = unsafe { key.as_ref() }.map(|k| &k.material) else {
        return 0;
    };
    let Some((n, _)) = rsa_public_parts(public) else {
        return 0;
    };
    if n.is_empty() {
        return 0;
    }
    (n.len() as u32 - 1) * 8 + (8 - n[0].leading_zeros())
}

/// JWK components as raw big-endian bytes. Field ids: 0 n, 1 e, 2 d, 3 p, 4 q,
/// 5 dp, 6 dq, 7 qi for RSA; 0 x, 1 y, 2 d for EC; 0 x, 2 d for Ed25519.
/// Length-probe: a too-small buffer reports the needed size in `written`.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_jwk_field(
    key: *const MalPkey,
    field: u32,
    out: *mut u8,
    cap: usize,
    written: *mut usize,
) -> i32 {
    let Some(key) = (unsafe { key.as_ref() }) else {
        return MAL_PKEY_INVALID_ARGUMENT;
    };
    match &key.material {
        Material::Rsa { public, private } => {
            let Some((n, e)) = rsa_public_parts(public) else {
                return MAL_PKEY_INVALID_KEY;
            };
            match field {
                0 => write_out(n, out, cap, written),
                1 => write_out(e, out, cap, written),
                2..=7 => {
                    let Some((der, _)) = private else {
                        return MAL_PKEY_NOT_PRIVATE;
                    };
                    let Some(parts) = rsa_private_parts(der) else {
                        return MAL_PKEY_INVALID_KEY;
                    };
                    write_out(parts[field as usize + 1], out, cap, written)
                }
                _ => MAL_PKEY_INVALID_ARGUMENT,
            }
        }
        Material::Ec {
            kind,
            point,
            scalar,
        } => {
            let size = ec_scalar_len(*kind);
            match field {
                0 => write_out(&point[1..1 + size], out, cap, written),
                1 => write_out(&point[1 + size..], out, cap, written),
                2 => match scalar {
                    Some(d) => write_out(d, out, cap, written),
                    None => MAL_PKEY_NOT_PRIVATE,
                },
                _ => MAL_PKEY_INVALID_ARGUMENT,
            }
        }
        Material::Ed25519 { public, seed } => match field {
            0 => write_out(public, out, cap, written),
            2 => match seed {
                Some(s) => write_out(s, out, cap, written),
                None => MAL_PKEY_NOT_PRIVATE,
            },
            _ => MAL_PKEY_INVALID_ARGUMENT,
        },
    }
}

fn export_der(
    material: &Material,
    key_type: u32,
    private: bool,
) -> Result<(Vec<u8>, &'static str), i32> {
    if !private {
        return match (material, key_type) {
            (Material::Rsa { public, .. }, TYPE_PKCS1) => Ok((public.clone(), "RSA PUBLIC KEY")),
            (Material::Rsa { public, .. }, TYPE_SPKI) => {
                Ok((seq(&[&rsa_algorithm(), &bit_string(public)]), "PUBLIC KEY"))
            }
            (Material::Ec { kind, point, .. }, TYPE_SPKI) => Ok((
                seq(&[&ec_algorithm(*kind), &bit_string(point)]),
                "PUBLIC KEY",
            )),
            (Material::Ed25519 { public, .. }, TYPE_SPKI) => Ok((
                seq(&[&seq(&[&tlv(0x06, OID_ED25519)]), &bit_string(public)]),
                "PUBLIC KEY",
            )),
            _ => Err(MAL_PKEY_INVALID_ARGUMENT),
        };
    }
    let version0: &[u8] = &[0x02, 0x01, 0x00];
    match (material, key_type) {
        (
            Material::Rsa {
                private: Some((der, _)),
                ..
            },
            TYPE_PKCS1,
        ) => Ok((der.clone(), "RSA PRIVATE KEY")),
        (
            Material::Rsa {
                private: Some((der, _)),
                ..
            },
            TYPE_PKCS8,
        ) => Ok((
            seq(&[version0, &rsa_algorithm(), &tlv(0x04, der)]),
            "PRIVATE KEY",
        )),
        (
            Material::Ec {
                kind,
                point,
                scalar: Some(d),
            },
            TYPE_SEC1,
        ) => Ok((
            seq(&[
                &[0x02, 0x01, 0x01],
                &tlv(0x04, d),
                &tlv(0xa0, &tlv(0x06, ec_curve_oid(*kind))),
                &tlv(0xa1, &bit_string(point)),
            ]),
            "EC PRIVATE KEY",
        )),
        (
            Material::Ec {
                kind,
                point,
                scalar: Some(d),
            },
            TYPE_PKCS8,
        ) => {
            // OpenSSL leaves the curve out of the inner ECPrivateKey; the algorithm names it.
            let inner = seq(&[
                &[0x02, 0x01, 0x01],
                &tlv(0x04, d),
                &tlv(0xa1, &bit_string(point)),
            ]);
            Ok((
                seq(&[version0, &ec_algorithm(*kind), &tlv(0x04, &inner)]),
                "PRIVATE KEY",
            ))
        }
        (Material::Ed25519 { seed: Some(s), .. }, TYPE_PKCS8) => Ok((
            seq(&[
                version0,
                &seq(&[&tlv(0x06, OID_ED25519)]),
                &tlv(0x04, &tlv(0x04, s)),
            ]),
            "PRIVATE KEY",
        )),
        (Material::Rsa { private: None, .. }, _)
        | (Material::Ec { scalar: None, .. }, _)
        | (Material::Ed25519 { seed: None, .. }, _) => Err(MAL_PKEY_NOT_PRIVATE),
        _ => Err(MAL_PKEY_INVALID_ARGUMENT),
    }
}

/// Exports the private (`private`) or public half as PEM text or DER bytes.
/// Length-probe: a too-small buffer reports the needed size in `written`.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_export(
    key: *const MalPkey,
    format: u32,
    key_type: u32,
    private: bool,
    out: *mut u8,
    cap: usize,
    written: *mut usize,
) -> i32 {
    let Some(key) = (unsafe { key.as_ref() }) else {
        return MAL_PKEY_INVALID_ARGUMENT;
    };
    let (mut der, label) = match export_der(&key.material, key_type, private) {
        Ok(result) => result,
        Err(status) => return status,
    };
    let status = match format {
        FORMAT_DER => write_out(&der, out, cap, written),
        FORMAT_PEM => {
            let mut pem = format!("-----BEGIN {label}-----\n").into_bytes();
            pem.extend_from_slice(&base64_encode_lines(&der));
            pem.extend_from_slice(format!("-----END {label}-----\n").as_bytes());
            let status = write_out(&pem, out, cap, written);
            pem.iter_mut().for_each(|b| *b = 0);
            status
        }
        _ => MAL_PKEY_INVALID_ARGUMENT,
    };
    der.iter_mut().for_each(|b| *b = 0);
    status
}

#[no_mangle]
pub unsafe extern "C" fn mal_pkey_equals(a: *const MalPkey, b: *const MalPkey) -> bool {
    let (Some(a), Some(b)) = (unsafe { a.as_ref() }, unsafe { b.as_ref() }) else {
        return false;
    };
    match (&a.material, &b.material) {
        (
            Material::Rsa {
                public: pa,
                private: sa,
            },
            Material::Rsa {
                public: pb,
                private: sb,
            },
        ) => pa == pb && sa.as_ref().map(|s| &s.0) == sb.as_ref().map(|s| &s.0),
        (
            Material::Ec {
                kind: ka,
                point: pa,
                scalar: sa,
            },
            Material::Ec {
                kind: kb,
                point: pb,
                scalar: sb,
            },
        ) => ka == kb && pa == pb && sa == sb,
        (
            Material::Ed25519 {
                public: pa,
                seed: sa,
            },
            Material::Ed25519 {
                public: pb,
                seed: sb,
            },
        ) => pa == pb && sa == sb,
        _ => false,
    }
}

/// p1363 r||s to a DER ECDSA-Sig-Value, for verifying with ring's ASN.1 algorithms.
fn p1363_to_der(signature: &[u8], size: usize) -> Option<Vec<u8>> {
    if signature.len() != 2 * size {
        return None;
    }
    Some(seq(&[
        &unsigned_integer(&signature[..size]),
        &unsigned_integer(&signature[size..]),
    ]))
}

const PADDING_PKCS1: u32 = 1;
const PADDING_PSS: u32 = 6;

/// Signs `message`. `pss_salt` is the PSS salt length, which ring fixes to the
/// digest length; other lengths are reported as unsupported.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_sign(
    key: *const MalPkey,
    hash: u32,
    padding: u32,
    pss_salt: i32,
    p1363: bool,
    message: *const u8,
    message_len: usize,
    out: *mut u8,
    cap: usize,
    written: *mut usize,
) -> i32 {
    let Some(key) = (unsafe { key.as_ref() }) else {
        return MAL_PKEY_INVALID_ARGUMENT;
    };
    let message = unsafe { slice(message, message_len) };
    let rng = SystemRandom::new();
    let signature: Vec<u8> = match &key.material {
        Material::Rsa {
            private: Some((_, pair)),
            ..
        } => {
            let encoding: &'static dyn signature::RsaEncoding = match (padding, hash) {
                (PADDING_PKCS1, HASH_SHA256) => &signature::RSA_PKCS1_SHA256,
                (PADDING_PKCS1, HASH_SHA384) => &signature::RSA_PKCS1_SHA384,
                (PADDING_PKCS1, HASH_SHA512) => &signature::RSA_PKCS1_SHA512,
                (PADDING_PSS, HASH_SHA256) => &signature::RSA_PSS_SHA256,
                (PADDING_PSS, HASH_SHA384) => &signature::RSA_PSS_SHA384,
                (PADDING_PSS, HASH_SHA512) => &signature::RSA_PSS_SHA512,
                _ => return MAL_PKEY_UNSUPPORTED,
            };
            if padding == PADDING_PSS && pss_salt != hash_len(hash) as i32 {
                return MAL_PKEY_UNSUPPORTED;
            }
            let mut buffer = vec![0u8; pair.public().modulus_len()];
            if pair.sign(encoding, &rng, message, &mut buffer).is_err() {
                return MAL_PKEY_INVALID_KEY;
            }
            buffer
        }
        Material::Ec {
            kind,
            point,
            scalar: Some(d),
        } => {
            let alg = match (*kind, hash, p1363) {
                (KIND_EC_P256, HASH_SHA256, false) => &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
                (KIND_EC_P256, HASH_SHA256, true) => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
                (KIND_EC_P384, HASH_SHA384, false) => &signature::ECDSA_P384_SHA384_ASN1_SIGNING,
                (KIND_EC_P384, HASH_SHA384, true) => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
                _ => return MAL_PKEY_UNSUPPORTED,
            };
            let Ok(pair) = EcdsaKeyPair::from_private_key_and_public_key(alg, d, point, &rng)
            else {
                return MAL_PKEY_INVALID_KEY;
            };
            match pair.sign(&rng, message) {
                Ok(sig) => sig.as_ref().to_vec(),
                Err(_) => return MAL_PKEY_INVALID_KEY,
            }
        }
        Material::Ed25519 {
            public,
            seed: Some(s),
        } => {
            if hash != HASH_NONE {
                return MAL_PKEY_UNSUPPORTED;
            }
            let Ok(pair) = Ed25519KeyPair::from_seed_and_public_key(s, public) else {
                return MAL_PKEY_INVALID_KEY;
            };
            pair.sign(message).as_ref().to_vec()
        }
        _ => return MAL_PKEY_NOT_PRIVATE,
    };
    write_out(&signature, out, cap, written)
}

fn hash_len(hash: u32) -> usize {
    match hash {
        HASH_SHA256 => 32,
        HASH_SHA384 => 48,
        HASH_SHA512 => 64,
        _ => 0,
    }
}

/// Verifies with the public half of any key. Returns OK or BAD_SIGNATURE.
#[no_mangle]
pub unsafe extern "C" fn mal_pkey_verify(
    key: *const MalPkey,
    hash: u32,
    padding: u32,
    pss_salt: i32,
    p1363: bool,
    message: *const u8,
    message_len: usize,
    sig: *const u8,
    sig_len: usize,
) -> i32 {
    let Some(key) = (unsafe { key.as_ref() }) else {
        return MAL_PKEY_INVALID_ARGUMENT;
    };
    let message = unsafe { slice(message, message_len) };
    let sig = unsafe { slice(sig, sig_len) };
    let ok = match &key.material {
        Material::Rsa { public, .. } => {
            let bits = unsafe { mal_pkey_modulus_bits(key) };
            let alg: &'static signature::RsaParameters = match (padding, hash, bits >= 2048) {
                (PADDING_PKCS1, HASH_SHA256, true) => &signature::RSA_PKCS1_2048_8192_SHA256,
                (PADDING_PKCS1, HASH_SHA384, true) => &signature::RSA_PKCS1_2048_8192_SHA384,
                (PADDING_PKCS1, HASH_SHA512, true) => &signature::RSA_PKCS1_2048_8192_SHA512,
                (PADDING_PKCS1, HASH_SHA256, false) => {
                    &signature::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY
                }
                (PADDING_PKCS1, HASH_SHA512, false) => {
                    &signature::RSA_PKCS1_1024_8192_SHA512_FOR_LEGACY_USE_ONLY
                }
                (PADDING_PSS, HASH_SHA256, true) => &signature::RSA_PSS_2048_8192_SHA256,
                (PADDING_PSS, HASH_SHA384, true) => &signature::RSA_PSS_2048_8192_SHA384,
                (PADDING_PSS, HASH_SHA512, true) => &signature::RSA_PSS_2048_8192_SHA512,
                _ => return MAL_PKEY_UNSUPPORTED,
            };
            // Negative salt lengths are Node's digest/auto sentinels.
            if padding == PADDING_PSS && pss_salt >= 0 && pss_salt != hash_len(hash) as i32 {
                return MAL_PKEY_UNSUPPORTED;
            }
            UnparsedPublicKey::new(alg, public)
                .verify(message, sig)
                .is_ok()
        }
        Material::Ec { kind, point, .. } => {
            let alg = match (*kind, hash) {
                (KIND_EC_P256, HASH_SHA256) => &signature::ECDSA_P256_SHA256_ASN1,
                (KIND_EC_P256, HASH_SHA384) => &signature::ECDSA_P256_SHA384_ASN1,
                (KIND_EC_P384, HASH_SHA256) => &signature::ECDSA_P384_SHA256_ASN1,
                (KIND_EC_P384, HASH_SHA384) => &signature::ECDSA_P384_SHA384_ASN1,
                _ => return MAL_PKEY_UNSUPPORTED,
            };
            let der;
            let sig = if p1363 {
                match p1363_to_der(sig, ec_scalar_len(*kind)) {
                    Some(converted) => {
                        der = converted;
                        der.as_slice()
                    }
                    None => return MAL_PKEY_BAD_SIGNATURE,
                }
            } else {
                sig
            };
            UnparsedPublicKey::new(alg, point)
                .verify(message, sig)
                .is_ok()
        }
        Material::Ed25519 { public, .. } => {
            if hash != HASH_NONE {
                return MAL_PKEY_UNSUPPORTED;
            }
            UnparsedPublicKey::new(&signature::ED25519, public)
                .verify(message, sig)
                .is_ok()
        }
    };
    if ok {
        MAL_PKEY_OK
    } else {
        MAL_PKEY_BAD_SIGNATURE
    }
}
