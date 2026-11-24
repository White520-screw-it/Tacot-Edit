use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
pub struct SavedExport {
    pub path: String,
    pub bytes: usize,
}

struct Sink {
    file: File,
    part: PathBuf,
    target: PathBuf,
    written: usize,
}

/// Streaming export sink so large renders never travel through the IPC layer in one piece.
#[derive(Default)]
pub struct ExportSink(Mutex<HashMap<String, Sink>>);

fn videos_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "could not find the home folder".to_string())?;
    let root = PathBuf::from(home);
    let candidate = root.join("Videos");
    let base = if candidate.is_dir() { candidate } else { root };
    Ok(base.join("Tacot Edit"))
}

fn safe_name(name: &str, fallback_ext: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        cleaned = "Tacot Edit Export".to_string();
    }
    if !cleaned.to_lowercase().ends_with(fallback_ext) {
        cleaned.push_str(fallback_ext);
    }
    cleaned.chars().take(120).collect()
}

fn unique_path(dir: &PathBuf, name: &str, ext: &str) -> PathBuf {
    let mut file = dir.join(safe_name(name, ext));
    if !file.exists() {
        return file;
    }
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Export".to_string());
    let mut index = 2;
    loop {
        let candidate = dir.join(format!("{stem} {index}{ext}"));
        if !candidate.exists() {
            file = candidate;
            break;
        }
        index += 1;
    }
    file
}

#[tauri::command]
pub fn export_dir() -> Result<String, String> {
    let dir = videos_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create export folder: {err}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_begin(sink: State<'_, ExportSink>, name: String, ext: String) -> Result<String, String> {
    let dir = videos_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create export folder: {err}"))?;
    let dot_ext = format!(".{}", ext.trim_start_matches('.').to_lowercase());
    let target = unique_path(&dir, &name, &dot_ext);
    let part = target.with_extension(format!("{}.part", dot_ext.trim_start_matches('.')));
    let file = File::create(&part).map_err(|err| format!("could not start export: {err}"))?;
    let id = format!(
        "exp{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let mut guard = sink.0.lock().map_err(|_| "export sink is locked".to_string())?;
    guard.insert(
        id.clone(),
        Sink {
            file,
            part,
            target,
            written: 0,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn export_chunk(sink: State<'_, ExportSink>, id: String, chunk: String) -> Result<usize, String> {
    let bytes = STANDARD
        .decode(chunk.as_bytes())
        .map_err(|err| format!("bad export chunk: {err}"))?;
    let mut guard = sink.0.lock().map_err(|_| "export sink is locked".to_string())?;
    let entry = guard.get_mut(&id).ok_or_else(|| "unknown export".to_string())?;
    entry
        .file
        .write_all(&bytes)
        .map_err(|err| format!("could not write export: {err}"))?;
    entry.written += bytes.len();
    Ok(entry.written)
}

#[tauri::command]
pub fn export_finish(sink: State<'_, ExportSink>, id: String) -> Result<SavedExport, String> {
    let mut guard = sink.0.lock().map_err(|_| "export sink is locked".to_string())?;
    let mut entry = guard.remove(&id).ok_or_else(|| "unknown export".to_string())?;
    entry.file.flush().map_err(|err| format!("could not flush export: {err}"))?;
    drop(entry.file);
    std::fs::rename(&entry.part, &entry.target).map_err(|err| format!("could not finish export: {err}"))?;
    Ok(SavedExport {
        path: entry.target.to_string_lossy().to_string(),
        bytes: entry.written,
    })
}

#[tauri::command]
pub fn export_abort(sink: State<'_, ExportSink>, id: String) -> Result<(), String> {
    let mut guard = sink.0.lock().map_err(|_| "export sink is locked".to_string())?;
    if let Some(entry) = guard.remove(&id) {
        drop(entry.file);
        let _ = std::fs::remove_file(&entry.part);
    }
    Ok(())
}

#[tauri::command]
pub fn export_remove(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|err| format!("could not remove {path}: {err}"))
}

#[tauri::command]
pub fn export_reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|err| format!("could not open the folder: {err}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("revealing files is only wired up on Windows".into())
    }
}

/// Small one-shot writes (project thumbnails, short clips).
#[tauri::command]
pub fn export_write(name: String, ext: String, bytes: Vec<u8>) -> Result<SavedExport, String> {
    let dir = videos_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create export folder: {err}"))?;
    let dot_ext = format!(".{}", ext.trim_start_matches('.').to_lowercase());
    let file = unique_path(&dir, &name, &dot_ext);
    std::fs::write(&file, &bytes).map_err(|err| format!("could not write export: {err}"))?;
    Ok(SavedExport {
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}
