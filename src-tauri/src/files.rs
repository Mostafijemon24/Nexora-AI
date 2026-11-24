//! Saving exports (CSV reports, backups) where the user will find them.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const FALLBACK_NAME: &str = "nexora-export.txt";
/// Characters no desktop file system accepts in a file name.
const FORBIDDEN: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Reduces whatever the UI sent to a plain file name: no directories, no control or reserved
/// characters, never empty or hidden.
pub fn safe_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !FORBIDDEN.contains(c)).collect();
    let name: String = cleaned.trim().trim_matches('.').trim().chars().take(120).collect();
    let name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() { FALLBACK_NAME.to_string() } else { name }
}

fn numbered(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Writes `contents` to `dir/name`. A file that is already there is never replaced: the new one
/// becomes "name (2).ext", "name (3).ext" and so on. Returns the path that was written.
pub fn write_new(dir: &Path, name: &str, contents: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    for n in 1..=999 {
        let path = dir.join(if n == 1 { name.to_string() } else { numbered(name, n) });
        // `create_new` fails if the file exists, so two saves can never overwrite each other.
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "Too many files with that name."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_cannot_leave_the_folder() {
        assert_eq!(safe_file_name("leads.csv"), "leads.csv");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Windows\\system.ini"), "system.ini");
        assert_eq!(safe_file_name("..\\..\\boot.ini"), "boot.ini");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name("re:port?*.csv"), "report.csv");
        assert_eq!(safe_file_name("a\u{0}b\n.csv"), "ab.csv");
        assert_eq!(safe_file_name(""), FALLBACK_NAME);
        assert_eq!(safe_file_name("../"), FALLBACK_NAME);
        assert_eq!(safe_file_name(".."), FALLBACK_NAME);
        assert_eq!(safe_file_name("নেক্সোরা লিডস.csv"), "নেক্সোরা লিডস.csv");
    }

    #[test]
    fn an_existing_file_is_kept_and_the_new_one_is_numbered() {
        let dir = std::env::temp_dir().join(format!("nexora-files-{}", uuid::Uuid::new_v4()));
        let first = write_new(&dir, "leads.csv", "one").unwrap();
        let second = write_new(&dir, "leads.csv", "two").unwrap();
        let third = write_new(&dir, "leads.csv", "three").unwrap();
        assert_eq!(first.file_name().unwrap(), "leads.csv");
        assert_eq!(second.file_name().unwrap(), "leads (2).csv");
        assert_eq!(third.file_name().unwrap(), "leads (3).csv");
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two");
        assert_eq!(write_new(&dir, "backup", "x").unwrap().file_name().unwrap(), "backup");
        assert_eq!(write_new(&dir, "backup", "y").unwrap().file_name().unwrap(), "backup (2)");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
