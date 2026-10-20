// Portions derived from Node.js src/crypto/crypto_common.cc (MIT); see THIRD_PARTY_NOTICES.md.
//! X.509 DER reading shared by node:tls peer certificates and node:crypto's X509Certificate.
//! Every function borrows its input; nothing is retained.

use std::borrow::Cow;

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

// OpenSSL's short names (OBJ_nid2sn), which Node uses as subject/issuer keys.
pub(crate) fn attribute_name(oid: &[u8]) -> Option<&'static str> {
    Some(match oid {
        [0x55, 0x04, 0x03] => "CN",
        [0x55, 0x04, 0x04] => "SN",
        [0x55, 0x04, 0x05] => "serialNumber",
        [0x55, 0x04, 0x06] => "C",
        [0x55, 0x04, 0x07] => "L",
        [0x55, 0x04, 0x08] => "ST",
        [0x55, 0x04, 0x09] => "street",
        [0x55, 0x04, 0x0a] => "O",
        [0x55, 0x04, 0x0b] => "OU",
        [0x55, 0x04, 0x0c] => "title",
        [0x55, 0x04, 0x0d] => "description",
        [0x55, 0x04, 0x0f] => "businessCategory",
        [0x55, 0x04, 0x11] => "postalCode",
        [0x55, 0x04, 0x29] => "name",
        [0x55, 0x04, 0x2a] => "GN",
        [0x55, 0x04, 0x2b] => "initials",
        [0x55, 0x04, 0x2c] => "generationQualifier",
        [0x55, 0x04, 0x2e] => "dnQualifier",
        [0x55, 0x04, 0x41] => "pseudonym",
        [0x55, 0x04, 0x61] => "organizationIdentifier",
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01] => "emailAddress",
        [0x09, 0x92, 0x26, 0x89, 0x93, 0xf2, 0x2c, 0x64, 0x01, 0x01] => "UID",
        [0x09, 0x92, 0x26, 0x89, 0x93, 0xf2, 0x2c, 0x64, 0x01, 0x19] => "DC",
        [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x3c, 0x02, 0x01, 0x01] => "jurisdictionL",
        [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x3c, 0x02, 0x01, 0x02] => "jurisdictionST",
        [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x3c, 0x02, 0x01, 0x03] => "jurisdictionC",
        _ => return None,
    })
}

fn attribute_key(oid: &[u8]) -> Cow<'static, str> {
    attribute_name(oid).map_or_else(|| Cow::Owned(oid_text(oid)), Cow::Borrowed)
}

/// Records `kind | key length | value length | key | NUL | value`, lengths as native-endian
/// u64. Values are arbitrary UTF-8 (certificate text may hold NUL); keys are short names or
/// dotted OIDs, so the NUL after a key only spares C a copy.
pub(crate) fn push_record(out: &mut Vec<u8>, kind: u8, key: &[u8], value: &[u8]) {
    out.push(kind);
    out.extend_from_slice(&(key.len() as u64).to_ne_bytes());
    out.extend_from_slice(&(value.len() as u64).to_ne_bytes());
    out.extend_from_slice(key);
    out.push(0);
    out.extend_from_slice(value);
}

/// An ASN.1 string's text the way OpenSSL's ASN1_STRING_to_UTF8 reads it: BMPString is UCS-2,
/// UniversalString UCS-4, UTF8String UTF-8, and every single-byte type Latin-1.
pub(crate) fn decode_string(tag: u8, value: &[u8]) -> String {
    let unit = |code: u32| char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER);
    match tag {
        0x0c => String::from_utf8_lossy(value).into_owned(),
        0x1e => value.chunks(2).map(|pair| if pair.len() == 2 { unit(u32::from(u16::from_be_bytes([pair[0], pair[1]]))) } else { char::REPLACEMENT_CHARACTER }).collect(),
        0x1c => value.chunks(4).map(|quad| quad.try_into().map_or(char::REPLACEMENT_CHARACTER, |quad| unit(u32::from_be_bytes(quad)))).collect(),
        _ => value.iter().map(|&byte| char::from(byte)).collect(),
    }
}

pub(crate) struct Attribute<'a> {
    pub(crate) oid: &'a [u8],
    pub(crate) tag: u8,
    pub(crate) value: &'a [u8],
    pub(crate) value_tlv: &'a [u8],
}

/// A Name's relative distinguished names in DER order, each with its attributes.
pub(crate) fn name_rdns(mut name: &[u8]) -> Option<Vec<Vec<Attribute<'_>>>> {
    let mut rdns = Vec::new();
    while !name.is_empty() {
        let (_, mut set, rest) = der(name)?;
        name = rest;
        let mut attributes = Vec::new();
        while !set.is_empty() {
            let (_, attribute, rest) = der(set)?;
            set = rest;
            let (_, oid, value_tlv) = der(attribute)?;
            let (tag, value, _) = der(value_tlv)?;
            attributes.push(Attribute { oid, tag, value, value_tlv });
        }
        rdns.push(attributes);
    }
    Some(rdns)
}

/// getPeerCertificate's subject/issuer entries: every attribute, values unescaped as Node does.
pub(crate) fn push_name(out: &mut Vec<u8>, kind: u8, name: &[u8]) -> Option<()> {
    for attribute in name_rdns(name)?.iter().flatten() {
        let key = attribute_key(attribute.oid);
        push_record(out, kind, key.as_bytes(), decode_string(attribute.tag, attribute.value).as_bytes());
    }
    Some(())
}

// X509_NAME_print_ex's ASN1_STRFLGS_ESC_2253 escaping with UTF8_CONVERT and without ESC_MSB;
// `control` adds ESC_CTRL.
fn escape_name_value(text: &str, control: bool) -> String {
    let count = text.chars().count();
    let mut out = String::with_capacity(text.len());
    for (index, c) in text.chars().enumerate() {
        match c {
            '"' | '+' | ',' | ';' | '<' | '>' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '#' if index == 0 => out.push_str("\\#"),
            ' ' if index == 0 || index + 1 == count => out.push_str("\\ "),
            '\0'..='\u{1f}' | '\u{7f}' if control => out.push_str(&format!("\\{:02X}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

/// Node's X509Certificate.subject/issuer: X509_NAME_print_ex with XN_FLAG_SEP_MULTILINE,
/// XN_FLAG_FN_SN, ASN1_STRFLGS_ESC_2253, ESC_CTRL and UTF8_CONVERT.
pub(crate) fn name_lines(name: &[u8]) -> Option<String> {
    let lines: Vec<String> = name_rdns(name)?
        .iter()
        .map(|rdn| {
            rdn.iter()
                .map(|attribute| {
                    let value = decode_string(attribute.tag, attribute.value);
                    format!("{}={}", attribute_key(attribute.oid), escape_name_value(&value, true))
                })
                .collect::<Vec<_>>()
                .join(" + ")
        })
        .collect();
    Some(lines.join("\n"))
}

// XN_FLAG_RFC2253 without ESC_MSB and ESC_CTRL, which Node uses for DirName alt names.
fn name_rfc2253(name: &[u8]) -> Option<String> {
    let rdns: Vec<String> = name_rdns(name)?
        .iter()
        .rev()
        .map(|rdn| {
            rdn.iter()
                .map(|attribute| match attribute_name(attribute.oid) {
                    Some(key) if matches!(attribute.tag, 0x0c | 0x12..=0x16 | 0x19..=0x1c | 0x1e) => {
                        format!("{key}={}", escape_name_value(&decode_string(attribute.tag, attribute.value), false))
                    }
                    key => format!(
                        "{}=#{}",
                        key.map_or_else(|| oid_text(attribute.oid), str::to_string),
                        hex(attribute.value_tlv, false)
                    ),
                })
                .collect::<Vec<_>>()
                .join("+")
        })
        .collect();
    Some(rdns.join(","))
}

// Node's PrintAltName: names that could not be split back unambiguously become JSON strings.
fn push_alt_name(out: &mut Vec<u8>, name: &[u8], utf8: bool, safe_prefix: Option<&str>) {
    let safe = name.iter().all(|&byte| match byte {
        b'"' | b'\\' | b',' | b'\'' => false,
        _ if utf8 => byte >= b' ' && byte != 0x7f,
        _ => (b' '..=b'~').contains(&byte),
    });
    if safe {
        if let Some(prefix) = safe_prefix {
            out.extend_from_slice(prefix.as_bytes());
            out.push(b':');
        }
        out.extend_from_slice(name);
        return;
    }
    out.push(b'"');
    if let Some(prefix) = safe_prefix {
        out.extend_from_slice(prefix.as_bytes());
        out.push(b':');
    }
    for &byte in name {
        match byte {
            b'"' | b'\\' => out.extend_from_slice(&[b'\\', byte]),
            b' '..=b'~' if byte != b',' => out.push(byte),
            0x80.. if utf8 => out.push(byte),
            _ => out.extend_from_slice(format!("\\u{byte:04x}").as_bytes()),
        }
    }
    out.push(b'"');
}

// Node's PrintGeneralName, OpenSSL 3 build.
fn push_general_name(out: &mut Vec<u8>, tag: u8, value: &[u8]) -> Option<()> {
    match tag {
        0x81 | 0x82 | 0x86 => {
            out.extend_from_slice(match tag {
                0x81 => b"email:".as_slice(),
                0x82 => b"DNS:",
                _ => b"URI:",
            });
            push_alt_name(out, value, false, None);
        }
        0xa4 => {
            let (_, name, _) = der(value)?;
            out.extend_from_slice(b"DirName:");
            push_alt_name(out, name_rfc2253(name)?.as_bytes(), true, None);
        }
        0x87 => {
            out.extend_from_slice(b"IP Address:");
            let text = match value.len() {
                4 => format!("{}.{}.{}.{}", value[0], value[1], value[2], value[3]),
                16 => value
                    .chunks(2)
                    .map(|pair| format!("{:X}", u16::from_be_bytes([pair[0], pair[1]])))
                    .collect::<Vec<_>>()
                    .join(":"),
                length => format!("<invalid length={length}>"),
            };
            out.extend_from_slice(text.as_bytes());
        }
        0x88 => out.extend_from_slice(format!("Registered ID:{}", oid_text(value)).as_bytes()),
        0xa0 => {
            let (_, type_id, rest) = der(value)?;
            let (_, explicit, _) = der(rest)?;
            let (value_tag, name, _) = der(explicit)?;
            let (prefix, unicode) = match type_id {
                [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x09] => ("SmtpUTF8Mailbox", true),
                [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x05] => ("XmppAddr", true),
                [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x07] => ("SRVName", false),
                [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x14, 0x02, 0x03] => ("UPN", true),
                [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x08] => ("NAIRealm", true),
                _ => ("", true),
            };
            if prefix.is_empty() || value_tag != if unicode { 0x0c } else { 0x16 } {
                out.extend_from_slice(b"othername:<unsupported>");
            } else {
                out.extend_from_slice(b"othername:");
                push_alt_name(out, name, unicode, Some(prefix));
            }
        }
        0xa3 => out.extend_from_slice(b"X400Name:<unsupported>"),
        0xa5 => out.extend_from_slice(b"EdiPartyName:<unsupported>"),
        _ => return None,
    }
    Some(())
}

/// Node's subjectaltname string: `, `-separated entries in which no separator can be forged.
pub(crate) fn subject_alt_name_text(mut names: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    while !names.is_empty() {
        let (tag, value, rest) = der(names)?;
        names = rest;
        if !out.is_empty() {
            out.extend_from_slice(b", ");
        }
        push_general_name(&mut out, tag, value)?;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Node's infoAccess text: one `method - general name` line per access description.
pub(crate) fn info_access_text(mut descriptions: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    while !descriptions.is_empty() {
        let (_, description, rest) = der(descriptions)?;
        descriptions = rest;
        let (_, method, location) = der(description)?;
        let (tag, location, _) = der(location)?;
        let method = match method {
            [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01] => "OCSP".to_string(),
            [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02] => "CA Issuers".to_string(),
            other => oid_text(other),
        };
        out.extend_from_slice(format!("{method} - ").as_bytes());
        push_general_name(&mut out, tag, location)?;
        out.push(b'\n');
    }
    Some(String::from_utf8_lossy(&out).into_owned())
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

/// `push_record` records: `S`/`I` for subject/issuer attributes, `F` for fields, in the order
/// Node's getPeerCertificate lists them.
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
                push_record(&mut out, b'F', b"subjectaltname", subject_alt_name_text(names)?.as_bytes());
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
