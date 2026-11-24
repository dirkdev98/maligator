#[cfg(not(feature = "std"))]
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use alloc::ffi::CString;
#[cfg(not(feature = "std"))]
use alloc::format;
use alloc::vec::Vec;
use core::ffi::CStr;
use jiff_core::civil::DateTime;
use jiff_core::tz::{posix, tzif, AmbiguousOffset, Offset};
use jiff_core::Timestamp;

#[cfg(unix)]
const LOCALTIME: &CStr = c"/etc/localtime";
const ZONEINFO_DIRECTORIES: [&str; 3] = [
    "/usr/share/zoneinfo",
    "/usr/share/lib/zoneinfo",
    "/etc/zoneinfo",
];

pub(crate) struct TimeZone {
    name: Option<Box<str>>,
    rules: Rules,
}

enum Rules {
    Utc,
    Tzif(tzif::TimeZone),
    Posix(posix::TimeZone),
}

impl TimeZone {
    const UTC: Self = Self {
        name: None,
        rules: Rules::Utc,
    };

    pub(crate) fn from_tzif(name: Option<&str>, bytes: &[u8]) -> Option<Self> {
        let rules = Rules::Tzif(tzif::TimeZone::parse(bytes).ok()?);
        Some(Self {
            name: name.map(Box::from),
            rules,
        })
    }

    pub(crate) fn name(&self) -> &str {
        self.name.as_deref().unwrap_or("UTC")
    }

    pub(crate) fn to_offset(&self, instant: Timestamp) -> Offset {
        match &self.rules {
            Rules::Utc => Offset::UTC,
            Rules::Tzif(zone) => zone.to_offset(instant),
            Rules::Posix(zone) => zone.to_offset(instant),
        }
    }

    pub(crate) fn local_offset(&self, local_time: DateTime) -> Offset {
        let offset = match &self.rules {
            Rules::Utc => return Offset::UTC,
            Rules::Tzif(zone) => zone.to_ambiguous_timestamp(local_time).offset(),
            Rules::Posix(zone) => zone.to_ambiguous_timestamp(local_time).offset(),
        };
        // ECMAScript uses the offset before a transition in both gaps and folds.
        match offset {
            AmbiguousOffset::Unambiguous { offset } => offset,
            AmbiguousOffset::Gap { before, .. } | AmbiguousOffset::Fold { before, .. } => before,
        }
    }
}

#[cfg(not(feature = "std"))]
fn env(name: &CStr) -> Option<CString> {
    let ptr = unsafe { libc::getenv(name.as_ptr()) };
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(ptr) }.to_owned())
    }
}

fn read_tzif(name: Option<&str>, path: &CStr) -> Option<TimeZone> {
    let file = unsafe { libc::fopen(path.as_ptr(), c"rb".as_ptr()) };
    if file.is_null() {
        return None;
    }
    let mut data = Vec::new();
    let mut block = [0u8; 4096];
    loop {
        let count = unsafe { libc::fread(block.as_mut_ptr().cast(), 1, block.len(), file) };
        data.extend_from_slice(&block[..count]);
        if count < block.len() {
            break;
        }
    }
    let failed = unsafe { libc::ferror(file) } != 0;
    unsafe { libc::fclose(file) };
    if failed {
        None
    } else {
        TimeZone::from_tzif(name, &data)
    }
}

fn zoneinfo_name(path: &str) -> Option<&str> {
    path.rsplit_once("zoneinfo/").map(|(_, name)| name)
}

#[cfg(not(feature = "std"))]
fn zoneinfo(name: &str) -> Option<TimeZone> {
    if name.starts_with('/') || name.split('/').any(|part| part == "..") {
        return None;
    }
    let bundled = jiff_tzdb::get(name);
    let canonical = if name.eq_ignore_ascii_case("UTC") {
        "UTC"
    } else {
        bundled.map_or(name, |(name, _)| name)
    };
    let configured = env(c"TZDIR");
    let explicit = configured
        .as_ref()
        .and_then(|dir| dir.to_str().ok())
        .into_iter();
    for directory in explicit.chain(ZONEINFO_DIRECTORIES) {
        let path = CString::new(format!("{directory}/{canonical}")).ok()?;
        if let Some(zone) = read_tzif(Some(canonical), &path) {
            return Some(zone);
        }
    }
    if name.eq_ignore_ascii_case("UTC") || name.eq_ignore_ascii_case("Etc/Unknown") {
        Some(TimeZone::UTC)
    } else {
        let (name, bytes) = bundled?;
        TimeZone::from_tzif(Some(name), bytes)
    }
}

#[cfg(feature = "std")]
fn zoneinfo(name: &str) -> Option<TimeZone> {
    use std::path::{Path, PathBuf};

    fn has_entries(dir: &Path, top: bool) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        entries.filter_map(Result::ok).any(|entry| {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                return false;
            };
            let Ok(kind) = entry.file_type() else {
                return false;
            };
            if kind.is_dir() {
                !(top && matches!(name, "posix" | "right")) && has_entries(&entry.path(), false)
            } else {
                true
            }
        })
    }

    if name.eq_ignore_ascii_case("UTC") || name.eq_ignore_ascii_case("Etc/Unknown") {
        return Some(TimeZone::UTC);
    }
    // TZDIR selects a database for the std provider. A missing name in that
    // database historically did not fall through to another zoneinfo directory.
    let dirs = std::env::var_os("TZDIR")
        .map(PathBuf::from)
        .into_iter()
        .chain(ZONEINFO_DIRECTORIES.map(PathBuf::from));
    let Some(mut dir) = dirs.into_iter().find(|dir| has_entries(dir, true)) else {
        let (name, bytes) = jiff_tzdb::get(name)?;
        return TimeZone::from_tzif(Some(name), bytes);
    };
    let mut resolved_name = alloc::string::String::new();
    let mut parts = name.split('/').peekable();
    while let Some(part) = parts.next() {
        let is_directory = parts.peek().is_some();
        let entry = std::fs::read_dir(&dir)
            .ok()?
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(part))
                    && entry
                        .file_type()
                        .is_ok_and(|kind| kind.is_dir() == is_directory)
            })?;
        let file_name = entry.file_name();
        let file_name = file_name.to_str()?;
        if resolved_name.is_empty() {
            if is_directory && matches!(file_name, "posix" | "right") {
                return None;
            }
        } else {
            resolved_name.push('/');
        }
        resolved_name.push_str(file_name);
        dir = entry.path();
    }
    TimeZone::from_tzif(Some(&resolved_name), &std::fs::read(dir).ok()?)
}

#[cfg(unix)]
fn zoneinfo_symlink(path: &CStr) -> Option<TimeZone> {
    let mut target = [0u8; libc::PATH_MAX as usize];
    let count = unsafe { libc::readlink(path.as_ptr(), target.as_mut_ptr().cast(), target.len()) };
    if count > 0 && (count as usize) < target.len() {
        return core::str::from_utf8(&target[..count as usize])
            .ok()
            .and_then(zoneinfo_name)
            .and_then(zoneinfo);
    }
    None
}

fn zone_file(path: &CStr) -> Option<TimeZone> {
    #[cfg(unix)]
    if let Some(zone) = zoneinfo_symlink(path) {
        return Some(zone);
    }
    read_tzif(None, path)
}

fn zone_from_env(setting: &str) -> Option<TimeZone> {
    if setting.is_empty() {
        return Some(TimeZone::UTC);
    }
    if !setting.starts_with(':') {
        if let Ok(zone) = posix::TimeZone::parse(setting) {
            return Some(TimeZone {
                name: None,
                rules: Rules::Posix(zone),
            });
        }
    }
    let setting = setting.strip_prefix(':').unwrap_or(setting);
    zoneinfo(zoneinfo_name(setting).unwrap_or(setting))
        .or_else(|| zone_file(&CString::new(setting).ok()?))
}

pub(crate) fn system() -> TimeZone {
    #[cfg(feature = "std")]
    let setting = std::env::var_os("TZ").map(|value| value.into_string().ok());
    #[cfg(not(feature = "std"))]
    let setting = env(c"TZ").map(|value| value.into_string().ok());
    let zone = match setting {
        Some(setting) => setting.as_deref().and_then(zone_from_env),
        #[cfg(unix)]
        None => zone_file(LOCALTIME),
        #[cfg(not(unix))]
        None => None,
    };
    zone.unwrap_or(TimeZone::UTC)
}
