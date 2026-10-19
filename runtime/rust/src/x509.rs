//! X.509 DER reading shared by node:tls peer certificates and node:crypto's X509Certificate.
//! Every function borrows its input; nothing is retained.

pub(crate) fn der(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, mut rest) = rest.split_first()?;
    let length = if first < 0x80 {
        first as usize
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let length = rest[..count].iter().fold(0usize, |length, &byte| length << 8 | byte as usize);
        rest = &rest[count..];
        length
    };
    (rest.len() >= length).then(|| (tag, &rest[..length], &rest[length..]))
}

pub(crate) fn attribute_name(oid: &[u8]) -> Option<&'static str> {
    Some(match oid {
        [0x55, 0x04, 0x03] => "CN",
        [0x55, 0x04, 0x04] => "SN",
        [0x55, 0x04, 0x05] => "serialNumber",
        [0x55, 0x04, 0x06] => "C",
        [0x55, 0x04, 0x07] => "L",
        [0x55, 0x04, 0x08] => "ST",
        [0x55, 0x04, 0x0a] => "O",
        [0x55, 0x04, 0x0b] => "OU",
        [0x55, 0x04, 0x2a] => "GN",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01] => "emailAddress",
        _ => return None,
    })
}

pub(crate) fn push_record(out: &mut Vec<u8>, kind: u8, key: &[u8], value: &[u8]) {
    out.push(kind);
    out.extend_from_slice(key);
    out.push(0);
    out.extend_from_slice(value);
    out.push(0);
}

pub(crate) fn push_name(out: &mut Vec<u8>, kind: u8, mut name: &[u8]) -> Option<()> {
    while !name.is_empty() {
        let (_, mut set, rest) = der(name)?;
        name = rest;
        while !set.is_empty() {
            let (_, attribute, rest) = der(set)?;
            set = rest;
            let (_, oid, value) = der(attribute)?;
            let (_, value, _) = der(value)?;
            if let Some(key) = attribute_name(oid) {
                push_record(out, kind, key.as_bytes(), value);
            }
        }
    }
    Some(())
}

// OpenSSL's ASN1_TIME_print layout, which Node's valid_from/valid_to expose.
pub(crate) fn push_time(out: &mut Vec<u8>, key: &[u8], tag: u8, time: &[u8]) -> Option<()> {
    let digits = |range: core::ops::Range<usize>| -> Option<u32> {
        core::str::from_utf8(time.get(range)?).ok()?.parse().ok()
    };
    let (year, rest) = match tag {
        0x17 => {
            let year = digits(0..2)?;
            (if year < 50 { 2000 + year } else { 1900 + year }, 2)
        }
        0x18 => (digits(0..4)?, 4),
        _ => return None,
    };
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = MONTHS.get(digits(rest..rest + 2)?.checked_sub(1)? as usize)?;
    let text = format!(
        "{} {:>2} {:02}:{:02}:{:02} {} GMT",
        month,
        digits(rest + 2..rest + 4)?,
        digits(rest + 4..rest + 6)?,
        digits(rest + 6..rest + 8)?,
        digits(rest + 8..rest + 10)?,
        year
    );
    push_record(out, b'F', key, text.as_bytes());
    Some(())
}

pub(crate) fn push_subject_alt_name(out: &mut Vec<u8>, mut names: &[u8]) -> Option<()> {
    let mut text = String::new();
    while !names.is_empty() {
        let (tag, value, rest) = der(names)?;
        names = rest;
        let entry = match tag {
            0x81 => format!("email:{}", String::from_utf8_lossy(value)),
            0x82 => format!("DNS:{}", String::from_utf8_lossy(value)),
            0x86 => format!("URI:{}", String::from_utf8_lossy(value)),
            0x87 if value.len() == 4 => format!("IP Address:{}.{}.{}.{}", value[0], value[1], value[2], value[3]),
            _ => continue,
        };
        if !text.is_empty() {
            text.push_str(", ");
        }
        text.push_str(&entry);
    }
    push_record(out, b'F', b"subjectaltname", text.as_bytes());
    Some(())
}

pub(crate) fn hex(bytes: &[u8], separator: bool) -> String {
    let mut text = String::with_capacity(bytes.len() * 3);
    for (index, byte) in bytes.iter().enumerate() {
        if separator && index > 0 {
            text.push(':');
        }
        text.push_str(&format!("{byte:02X}"));
    }
    text
}

/// Records of `kind key NUL value NUL`: `S`/`I` for subject/issuer attributes, `F` for fields,
/// in the order Node's getPeerCertificate lists them.
pub(crate) fn describe_certificate(certificate: &[u8]) -> Option<Vec<u8>> {
    let (_, body, _) = der(certificate)?;
    let (_, tbs, _) = der(body)?;
    let (mut tag, mut field, mut rest) = der(tbs)?;
    if tag == 0xa0 {
        (tag, field, rest) = der(rest)?;
    }
    if tag != 0x02 {
        return None;
    }
    let mut serial = field;
    while serial.len() > 1 && serial[0] == 0 {
        serial = &serial[1..];
    }
    let (_, _, rest) = der(rest)?;
    let (_, issuer, rest) = der(rest)?;
    let (_, validity, rest) = der(rest)?;
    let (_, subject, mut rest) = der(rest)?;
    let mut out = Vec::new();
    push_name(&mut out, b'S', subject)?;
    push_name(&mut out, b'I', issuer)?;
    while !rest.is_empty() {
        let (tag, value, next) = der(rest)?;
        rest = next;
        if tag != 0xa3 {
            continue;
        }
        let (_, mut extensions, _) = der(value)?;
        while !extensions.is_empty() {
            let (_, extension, next) = der(extensions)?;
            extensions = next;
            let (_, oid, mut tail) = der(extension)?;
            let (mut tag, mut value, next) = der(tail)?;
            if tag == 0x01 {
                tail = next;
                (tag, value, _) = der(tail)?;
            }
            if oid == [0x55, 0x1d, 0x11] && tag == 0x04 {
                let (_, names, _) = der(value)?;
                push_subject_alt_name(&mut out, names)?;
            }
        }
    }
    let (from_tag, from, after) = der(validity)?;
    let (to_tag, to, _) = der(after)?;
    push_time(&mut out, b"valid_from", from_tag, from)?;
    push_time(&mut out, b"valid_to", to_tag, to)?;
    for (key, algorithm) in [
        (&b"fingerprint"[..], &ring::digest::SHA1_FOR_LEGACY_USE_ONLY),
        (&b"fingerprint256"[..], &ring::digest::SHA256),
        (&b"fingerprint512"[..], &ring::digest::SHA512),
    ] {
        push_record(&mut out, b'F', key, hex(ring::digest::digest(algorithm, certificate).as_ref(), true).as_bytes());
    }
    push_record(&mut out, b'F', b"serialNumber", hex(serial, false).as_bytes());
    Some(out)
}


/// A certificate's fields as borrowed DER: `*_tlv` slices keep their tag and length.
pub(crate) struct Certificate<'a> {
    pub(crate) tbs_tlv: &'a [u8],
    pub(crate) serial: &'a [u8],
    pub(crate) issuer_tlv: &'a [u8],
    pub(crate) subject_tlv: &'a [u8],
    pub(crate) issuer: &'a [u8],
    pub(crate) subject: &'a [u8],
    pub(crate) not_before: (u8, &'a [u8]),
    pub(crate) not_after: (u8, &'a [u8]),
    pub(crate) spki_tlv: &'a [u8],
    pub(crate) extensions: Vec<(&'a [u8], &'a [u8])>,
    pub(crate) signature_oid: &'a [u8],
    pub(crate) signature: &'a [u8],
}

fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8], &[u8])> {
    let (tag, content, rest) = der(input)?;
    Some((tag, content, &input[..input.len() - rest.len()], rest))
}

pub(crate) fn parse(certificate: &[u8]) -> Option<Certificate<'_>> {
    let (0x30, body, _, _) = tlv(certificate)? else { return None };
    let (0x30, tbs, tbs_tlv, rest) = tlv(body)? else { return None };
    let (0x30, algorithm, _, rest) = tlv(rest)? else { return None };
    let (0x03, signature, _, _) = tlv(rest)? else { return None };
    let (_, signature_oid, _) = der(algorithm)?;
    let (mut tag, mut serial, _, mut rest) = tlv(tbs)?;
    if tag == 0xa0 {
        (tag, serial, _, rest) = tlv(rest)?;
    }
    if tag != 0x02 {
        return None;
    }
    let (_, _, _, rest) = tlv(rest)?;
    let (_, issuer, issuer_tlv, rest) = tlv(rest)?;
    let (_, validity, _, rest) = tlv(rest)?;
    let (_, subject, subject_tlv, rest) = tlv(rest)?;
    let (_, _, spki_tlv, mut rest) = tlv(rest)?;
    let (before_tag, before, after) = der(validity)?;
    let (after_tag, after, _) = der(after)?;
    let mut extensions = Vec::new();
    while !rest.is_empty() {
        let (tag, value, next) = der(rest)?;
        rest = next;
        if tag != 0xa3 {
            continue;
        }
        let (_, mut list, _) = der(value)?;
        while !list.is_empty() {
            let (_, extension, next) = der(list)?;
            list = next;
            let (_, oid, tail) = der(extension)?;
            let (mut tag, mut value, next) = der(tail)?;
            if tag == 0x01 {
                (tag, value, _) = der(next)?;
            }
            if tag == 0x04 {
                extensions.push((oid, value));
            }
        }
    }
    Some(Certificate {
        tbs_tlv,
        serial,
        issuer_tlv,
        subject_tlv,
        issuer,
        subject,
        not_before: (before_tag, before),
        not_after: (after_tag, after),
        spki_tlv,
        extensions,
        signature_oid,
        signature: signature.get(1..)?,
    })
}

/// OpenSSL's ASN1_TIME_print text and the Unix time it names.
pub(crate) fn time_fields(tag: u8, time: &[u8]) -> Option<(String, i64)> {
    let digits = |range: core::ops::Range<usize>| -> Option<i64> {
        core::str::from_utf8(time.get(range)?).ok()?.parse().ok()
    };
    let (year, at) = match tag {
        0x17 => {
            let year = digits(0..2)?;
            (if year < 50 { 2000 + year } else { 1900 + year }, 2)
        }
        0x18 => (digits(0..4)?, 4),
        _ => return None,
    };
    let (month, day) = (digits(at..at + 2)?, digits(at + 2..at + 4)?);
    let (hour, minute, second) = (digits(at + 4..at + 6)?, digits(at + 6..at + 8)?, digits(at + 8..at + 10)?);
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let name = MONTHS.get(usize::try_from(month.checked_sub(1)?).ok()?)?;
    // Days from the civil date (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let text = format!("{name} {day:>2} {hour:02}:{minute:02}:{second:02} {year} GMT");
    Some((text, days * 86400 + hour * 3600 + minute * 60 + second))
}

/// Node's X509Certificate.subject/issuer: one `key=value` line per known attribute.
pub(crate) fn name_lines(mut name: &[u8]) -> Option<String> {
    let mut text = String::new();
    while !name.is_empty() {
        let (_, mut set, rest) = der(name)?;
        name = rest;
        while !set.is_empty() {
            let (_, attribute, rest) = der(set)?;
            set = rest;
            let (_, oid, value) = der(attribute)?;
            let (_, value, _) = der(value)?;
            if let Some(key) = attribute_name(oid) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(key);
                text.push('=');
                text.push_str(&String::from_utf8_lossy(value));
            }
        }
    }
    Some(text)
}

pub(crate) fn oid_text(oid: &[u8]) -> String {
    let mut parts: Vec<u64> = Vec::new();
    let mut value = 0u64;
    for (index, &byte) in oid.iter().enumerate() {
        value = value << 7 | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            if index == 0 || parts.is_empty() {
                let first = (value / 40).min(2);
                parts.push(first);
                parts.push(value - first * 40);
            } else {
                parts.push(value);
            }
            value = 0;
        }
    }
    parts.iter().map(u64::to_string).collect::<Vec<_>>().join(".")
}

pub(crate) fn signature_algorithm_name(oid: &[u8]) -> Option<&'static str> {
    Some(match oid {
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x05] => "sha1WithRSAEncryption",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a] => "rsassaPss",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b] => "sha256WithRSAEncryption",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c] => "sha384WithRSAEncryption",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d] => "sha512WithRSAEncryption",
        [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02] => "ecdsa-with-SHA256",
        [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03] => "ecdsa-with-SHA384",
        [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04] => "ecdsa-with-SHA512",
        [0x2b, 0x65, 0x70] => "ED25519",
        _ => return None,
    })
}

/// OpenSSL's self-signed test without the signature check: the issuer is the subject, and the
/// authority key identifier, when both identifiers are present, names the certificate's own key.
pub(crate) fn self_issued(certificate: &[u8]) -> bool {
    let Some(parsed) = parse(certificate) else {
        return false;
    };
    if parsed.issuer_tlv != parsed.subject_tlv {
        return false;
    }
    let mut subject_key = None;
    let mut authority_key = None;
    for (oid, value) in &parsed.extensions {
        match *oid {
            [0x55, 0x1d, 0x0e] => subject_key = der(value).map(|(_, id, _)| id),
            [0x55, 0x1d, 0x23] => {
                authority_key = der(value)
                    .and_then(|(_, fields, _)| der(fields))
                    .filter(|(tag, _, _)| *tag == 0x80)
                    .map(|(_, id, _)| id)
            }
            _ => {}
        }
    }
    match (authority_key, subject_key) {
        (Some(authority), Some(subject)) => authority == subject,
        _ => true,
    }
}
