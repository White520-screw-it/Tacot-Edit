use crate::AppDirs;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Serialize)]
pub struct ProjectEntry {
    pub name: String,
    pub modified: u64,
    pub bytes: usize,
}

fn safe_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn project_file(dirs: &AppDirs, name: &str) -> PathBuf {
    dirs.projects().join(format!("{}.tacot", safe_stem(name)))
}

fn modified_secs(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub fn project_save(dirs: State<'_, AppDirs>, name: String, json: String) -> Result<String, String> {
    let file = project_file(&dirs, &name);
    std::fs::write(&file, json.as_bytes()).map_err(|err| format!("could not save project: {err}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn project_load(dirs: State<'_, AppDirs>, name: String) -> Result<String, String> {
    let file = project_file(&dirs, &name);
    std::fs::read_to_string(&file).map_err(|err| format!("could not open project: {err}"))
}

#[tauri::command]
pub fn project_list(dirs: State<'_, AppDirs>) -> Result<Vec<ProjectEntry>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dirs.projects()) {
        Ok(entries) => entries,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "tacot").unwrap_or(true) {
            continue;
        }
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(ProjectEntry {
            name,
            modified: modified_secs(&path),
            bytes: entry.metadata().map(|m| m.len() as usize).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn project_delete(dirs: State<'_, AppDirs>, name: String) -> Result<(), String> {
    let file = project_file(&dirs, &name);
    std::fs::remove_file(&file).map_err(|err| format!("could not delete project: {err}"))
}

#[tauri::command]
pub fn autosave_write(dirs: State<'_, AppDirs>, json: String) -> Result<(), String> {
    let file = dirs.data.join("autosave.tacot");
    std::fs::write(&file, json.as_bytes()).map_err(|err| format!("autosave failed: {err}"))
}

#[tauri::command]
pub fn autosave_read(dirs: State<'_, AppDirs>) -> Result<Option<String>, String> {
    let file = dirs.data.join("autosave.tacot");
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&file).map(Some).map_err(|err| err.to_string())
}
