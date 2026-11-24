use alloc::borrow::ToOwned;
use alloc::ffi::CString;
use alloc::format;
use alloc::vec::Vec;
use core::ffi::CStr;
use jiff::tz::TimeZone;

const LOCALTIME: &CStr = c"/etc/localtime";

fn env(name: &CStr) -> Option<CString> {
    let ptr = unsafe { libc::getenv(name.as_ptr()) };
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(ptr) }.to_owned())
    }
}

fn read_tzif(name: &str, path: &CStr) -> Option<TimeZone> {
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
        TimeZone::tzif(name, &data).ok()
    }
}

fn zoneinfo_name(path: &str) -> Option<&str> {
    path.rsplit_once("zoneinfo/").map(|(_, name)| name)
}

fn zoneinfo(name: &str) -> Option<TimeZone> {
    if name.starts_with('/') || name.split('/').any(|part| part == "..") {
        return None;
    }
    let bundled = TimeZone::get(name).ok();
    let canonical = bundled.as_ref().and_then(TimeZone::iana_name).unwrap_or(name);
    let configured = env(c"TZDIR");
    let directories = ["/usr/share/zoneinfo", "/usr/share/lib/zoneinfo", "/etc/zoneinfo"];
    let explicit = configured.as_ref().and_then(|dir| dir.to_str().ok()).into_iter();
    for directory in explicit.chain(directories) {
        let path = CString::new(format!("{directory}/{canonical}")).ok()?;
        if let Some(zone) = read_tzif(canonical, &path) {
            return Some(zone);
        }
    }
    bundled
}

fn zone_file(path: &CStr) -> Option<TimeZone> {
    let mut target = [0u8; libc::PATH_MAX as usize];
    let count = unsafe { libc::readlink(path.as_ptr(), target.as_mut_ptr().cast(), target.len()) };
    if count > 0 && (count as usize) < target.len() {
        if let Some(zone) = core::str::from_utf8(&target[..count as usize])
            .ok()
            .and_then(zoneinfo_name)
            .and_then(zoneinfo)
        {
            return Some(zone);
        }
    }
    read_tzif("", path)
}

fn zone_from_env(setting: &CStr) -> Option<TimeZone> {
    let setting = setting.to_str().ok()?;
    if setting.is_empty() {
        return Some(TimeZone::UTC);
    }
    if !setting.starts_with(':') {
        if let Ok(zone) = TimeZone::posix(setting) {
            return Some(zone);
        }
    }
    let setting = setting.strip_prefix(':').unwrap_or(setting);
    zoneinfo(zoneinfo_name(setting).unwrap_or(setting))
        .or_else(|| zone_file(&CString::new(setting).ok()?))
}

pub(crate) fn system() -> TimeZone {
    match env(c"TZ") {
        Some(setting) => zone_from_env(&setting),
        None => zone_file(LOCALTIME),
    }
    .unwrap_or(TimeZone::UTC)
}
