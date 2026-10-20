//! node:crypto X509Certificate primitives over the shared DER reader. Inputs are borrowed for
//! one call; outputs are written to caller buffers and report their full length.

use crate::crypto_pkey::{base64_decode, base64_encode_lines};
use crate::x509::{
    der, hex, info_access_text, name_lines, oid_text, parse, push_record, signature_algorithm_name,
    subject_alt_name_text, time_fields,
};

unsafe fn input<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if length == 0 {
        Some(&[])
    } else if pointer.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts(pointer, length) })
    }
}

unsafe fn copy_out(bytes: &[u8], output: *mut u8, capacity: usize) -> isize {
    if !output.is_null() {
        let length = bytes.len().min(capacity);
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), output, length) };
    }
    bytes.len() as isize
}

fn certificate_der(input: &[u8]) -> Option<Vec<u8>> {
    const BEGIN: &[u8] = b"-----BEGIN CERTIFICATE-----";
    const END: &[u8] = b"-----END CERTIFICATE-----";
    let start = input.windows(BEGIN.len()).position(|window| window == BEGIN);
    let der = match start {
        Some(start) => {
            let body = &input[start + BEGIN.len()..];
            let end = body.windows(END.len()).position(|window| window == END)?;
            base64_decode(&body[..end])?
        }
        None => input.to_vec(),
    };
    parse(&der)?;
    Some(der)
}

#[no_mangle]
/// # Safety
/// `data` is valid for `len` bytes and `output` for `capacity`. Returns the DER length of the
/// first certificate in PEM or DER input, -1 when PEM text has no certificate block, or -2 for
/// malformed DER.
pub unsafe extern "C" fn mal_x509_from_input(
    data: *const u8,
    len: usize,
    output: *mut u8,
    capacity: usize,
) -> isize {
    let Some(data) = (unsafe { input(data, len) }) else {
        return -2;
    };
    match certificate_der(data) {
        Some(der) => unsafe { copy_out(&der, output, capacity) },
        None if data.first() == Some(&0x30) => -2,
        None => -1,
    }
}

fn info(certificate: &[u8]) -> Option<Vec<u8>> {
    let parsed = parse(certificate)?;
    let mut out = Vec::new();
    push_record(&mut out, b'F', b"subject", name_lines(parsed.subject)?.as_bytes());
    push_record(&mut out, b'F', b"issuer", name_lines(parsed.issuer)?.as_bytes());
    let mut ca = false;
    for (oid, value) in &parsed.extensions {
        match *oid {
            [0x55, 0x1d, 0x11] => {
                let (_, names, _) = der(value)?;
                push_record(&mut out, b'F', b"subjectAltName", subject_alt_name_text(names)?.as_bytes());
            }
            [0x55, 0x1d, 0x13] => {
                let (_, constraints, _) = der(value)?;
                ca = matches!(der(constraints), Some((0x01, [flag], _)) if *flag != 0);
            }
            [0x55, 0x1d, 0x25] => {
                let (_, mut purposes, _) = der(value)?;
                push_record(&mut out, b'F', b"keyUsage", b"");
                while !purposes.is_empty() {
                    let (_, purpose, rest) = der(purposes)?;
                    purposes = rest;
                    push_record(&mut out, b'K', b"", oid_text(purpose).as_bytes());
                }
            }
            [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01] => {
                let (_, descriptions, _) = der(value)?;
                push_record(&mut out, b'F', b"infoAccess", info_access_text(descriptions)?.as_bytes());
            }
            _ => {}
        }
    }
    let (from, from_time) = time_fields(parsed.not_before.0, parsed.not_before.1)?;
    let (to, to_time) = time_fields(parsed.not_after.0, parsed.not_after.1)?;
    push_record(&mut out, b'F', b"validFrom", from.as_bytes());
    push_record(&mut out, b'F', b"validTo", to.as_bytes());
    push_record(&mut out, b'T', b"validFromDate", from_time.to_string().as_bytes());
    push_record(&mut out, b'T', b"validToDate", to_time.to_string().as_bytes());
    for (key, algorithm) in [
        (&b"fingerprint"[..], &ring::digest::SHA1_FOR_LEGACY_USE_ONLY),
        (&b"fingerprint256"[..], &ring::digest::SHA256),
        (&b"fingerprint512"[..], &ring::digest::SHA512),
    ] {
        push_record(&mut out, b'F', key, hex(ring::digest::digest(algorithm, certificate).as_ref(), true).as_bytes());
    }
    let mut serial = parsed.serial;
    while serial.len() > 1 && serial[0] == 0 {
        serial = &serial[1..];
    }
    push_record(&mut out, b'F', b"serialNumber", hex(serial, false).as_bytes());
    if let Some(name) = signature_algorithm_name(parsed.signature_oid) {
        push_record(&mut out, b'F', b"signatureAlgorithm", name.as_bytes());
    }
    push_record(&mut out, b'F', b"signatureAlgorithmOid", oid_text(parsed.signature_oid).as_bytes());
    push_record(&mut out, b'B', b"ca", if ca { b"1" } else { b"0" });
    Some(out)
}

#[no_mangle]
/// # Safety
/// `der` is valid for `len` bytes and `output` for `capacity`. Returns the full length of
/// `push_record` records (F text, T Unix seconds, B boolean, K one keyUsage OID), or -1 for
/// malformed DER.
pub unsafe extern "C" fn mal_x509_info(der: *const u8, len: usize, output: *mut u8, capacity: usize) -> isize {
    match unsafe { input(der, len) }.and_then(info) {
        Some(records) => unsafe { copy_out(&records, output, capacity) },
        None => -1,
    }
}

pub const MAL_X509_PART_SPKI: u32 = 0;
pub const MAL_X509_PART_TBS: u32 = 1;
pub const MAL_X509_PART_SIGNATURE: u32 = 2;
pub const MAL_X509_PART_ISSUER: u32 = 3;
pub const MAL_X509_PART_SUBJECT: u32 = 4;

#[no_mangle]
/// # Safety
/// `der` is valid for `len` bytes; `offset` and `length` are writable.
pub unsafe extern "C" fn mal_x509_part(
    der: *const u8,
    len: usize,
    part: u32,
    offset: *mut usize,
    length: *mut usize,
) -> bool {
    let Some(certificate) = (unsafe { input(der, len) }) else {
        return false;
    };
    let Some(parsed) = parse(certificate) else {
        return false;
    };
    let slice = match part {
        MAL_X509_PART_SPKI => parsed.spki_tlv,
        MAL_X509_PART_TBS => parsed.tbs_tlv,
        MAL_X509_PART_SIGNATURE => parsed.signature,
        MAL_X509_PART_ISSUER => parsed.issuer_tlv,
        MAL_X509_PART_SUBJECT => parsed.subject_tlv,
        _ => return false,
    };
    if offset.is_null() || length.is_null() {
        return false;
    }
    unsafe {
        *offset = slice.as_ptr() as usize - certificate.as_ptr() as usize;
        *length = slice.len();
    }
    true
}

#[no_mangle]
/// # Safety
/// `der` is valid for `len` bytes and `output` for `capacity`. Returns the PEM length.
pub unsafe extern "C" fn mal_x509_pem(der: *const u8, len: usize, output: *mut u8, capacity: usize) -> isize {
    let Some(certificate) = (unsafe { input(der, len) }) else {
        return -1;
    };
    let mut pem = b"-----BEGIN CERTIFICATE-----\n".to_vec();
    pem.extend_from_slice(&base64_encode_lines(certificate));
    pem.extend_from_slice(b"-----END CERTIFICATE-----\n");
    unsafe { copy_out(&pem, output, capacity) }
}

#[no_mangle]
/// # Safety
/// `der` is valid for `len` bytes and `output` for `capacity`.
pub unsafe extern "C" fn mal_x509_legacy(der: *const u8, len: usize, output: *mut u8, capacity: usize) -> isize {
    match unsafe { input(der, len) }.and_then(crate::x509::describe_certificate) {
        Some(records) => unsafe { copy_out(&records, output, capacity) },
        None => -1,
    }
}
