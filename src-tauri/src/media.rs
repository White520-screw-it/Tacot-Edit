use crate::AppDirs;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
pub struct MediaFile {
    pub key: String,
    pub name: String,
    pub path: String,
    pub bytes: usize,
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.len().hash(&mut hasher);
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn safe_ext(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .filter(|ext| {
            !ext.is_empty()
                && ext.len() <= 5
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| "bin".to_string())
}

/// Copy an imported file into the app's media cache. Identical files are stored once.
#[tauri::command]
pub fn media_import(
    dirs: State<'_, AppDirs>,
    name: String,
    bytes: Vec<u8>,
) -> Result<MediaFile, String> {
    let ext = safe_ext(&name);
    let key = fingerprint(&bytes);
    let file = dirs.media().join(format!("{key}.{ext}"));
    if !file.exists() {
        std::fs::write(&file, &bytes).map_err(|err| format!("could not store media: {err}"))?;
    }
    Ok(MediaFile {
        key,
        name,
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

/// Resolve a cached media key back to a path (used when reopening a project).
#[tauri::command]
pub fn media_import_path(dirs: State<'_, AppDirs>, path: String) -> Result<MediaFile, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("no such file: {path}"));
    }
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "media".to_string());
    let ext = safe_ext(&name);

    let bytes = std::fs::read(&source).map_err(|err| format!("could not read {name}: {err}"))?;
    let key = fingerprint(&bytes);
    let file = dirs.media().join(format!("{key}.{ext}"));
    if !file.exists() {
        std::fs::write(&file, &bytes).map_err(|err| format!("could not store media: {err}"))?;
    }
    Ok(MediaFile {
        key,
        name,
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

#[tauri::command]
pub fn media_path(dirs: State<'_, AppDirs>, key: String, ext: String) -> Result<Option<String>, String> {
    if !key.chars().all(|c| c.is_ascii_hexdigit()) || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid media key".into());
    }
    let file = dirs.media().join(format!("{key}.{ext}"));
    if file.exists() {
        Ok(Some(file.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Remove cached media that no open project references any more.
#[tauri::command]
pub fn media_sweep(dirs: State<'_, AppDirs>, keep: Vec<String>) -> Result<usize, String> {
    let mut removed = 0usize;
    let entries = match std::fs::read_dir(dirs.media()) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if !keep.contains(&stem) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}
