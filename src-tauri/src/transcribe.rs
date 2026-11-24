use crate::AppDirs;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub confidence: f64,
}

#[derive(Serialize)]
pub struct Transcript {
    pub engine: String,
    pub language: String,
    pub segments: Vec<Segment>,
}

struct TempSink {
    file: File,
    path: PathBuf,
}

/// Chunked writer for derived audio (never exposed to the user's video folder).
#[derive(Default)]
pub struct TempSinks(Mutex<HashMap<String, TempSink>>);

#[tauri::command]
pub fn temp_begin(
    dirs: State<'_, AppDirs>,
    state: State<'_, TempSinks>,
    name: String,
    ext: String,
) -> Result<String, String> {
    let temp_dir = dirs.data.join("temp");
    std::fs::create_dir_all(&temp_dir).map_err(|err| format!("could not create temp folder: {err}"))?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = temp_dir.join(format!("{}-{}{}", safe, stamp, ext));
    let file = File::create(&path).map_err(|err| format!("could not create temp file: {err}"))?;
    let id = format!("tmp{stamp}");
    let mut guard = state.0.lock().map_err(|_| "temp sink locked".to_string())?;
    guard.insert(id.clone(), TempSink { file, path });
    Ok(id)
}

#[tauri::command]
pub fn temp_chunk(state: State<'_, TempSinks>, id: String, chunk: String) -> Result<usize, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(chunk.as_bytes())
        .map_err(|err| format!("bad audio chunk: {err}"))?;
    let mut guard = state.0.lock().map_err(|_| "temp sink locked".to_string())?;
    let entry = guard.get_mut(&id).ok_or_else(|| "unknown temp file".to_string())?;
    entry
        .file
        .write_all(&bytes)
        .map_err(|err| format!("could not write temp audio: {err}"))?;
    Ok(bytes.len())
}

#[tauri::command]
pub fn temp_finish(state: State<'_, TempSinks>, id: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "temp sink locked".to_string())?;
    let mut entry = guard.remove(&id).ok_or_else(|| "unknown temp file".to_string())?;
    entry.file.flush().map_err(|err| err.to_string())?;
    drop(entry.file);
    Ok(entry.path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn temp_discard(path: String) -> Result<(), String> {
    if Path::new(&path).is_file() {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

/// Where the speech engine may live: next to the executable first (the
/// installer ships it), then the per-user folder.
fn speech_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(folder) = exe.parent() {
            dirs.push(folder.join("bin").join("speech"));
            dirs.push(folder.join("resources").join("bin").join("speech"));
        }
    }
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        let bin = PathBuf::from(base).join("Tacot Edit").join("bin");
        dirs.push(bin.join("speech"));
        // earlier builds kept the engine under bin\whisper
        dirs.push(bin.join("whisper"));
    }
    dirs
}

fn speech_engine() -> Option<(PathBuf, PathBuf)> {
    let cli_names = ["whisper-cli.exe", "main.exe"];
    let models = ["ggml-base.en.bin", "ggml-base.bin", "ggml-small.en.bin", "ggml-small.bin", "ggml-tiny.en.bin"];
    for dir in speech_dirs() {
        let cli = cli_names.iter().map(|name| dir.join(name)).find(|path| path.is_file());
        let model = models.iter().map(|name| dir.join(name)).find(|path| path.is_file());
        if let (Some(cli), Some(model)) = (cli, model) {
            return Some((cli, model));
        }
    }
    None
}

fn parse_timestamp(text: &str) -> f64 {
    // whisper.cpp uses "00:00:01,250"
    let cleaned = text.replace(',', ".");
    let parts: Vec<f64> = cleaned.split(':').filter_map(|part| part.trim().parse::<f64>().ok()).collect();
    match parts.len() {
        3 => parts[0] * 3600.0 + parts[1] * 60.0 + parts[2],
        2 => parts[0] * 60.0 + parts[1],
        1 => parts[0],
        _ => 0.0,
    }
}

fn transcribe_whisper(cli: &Path, model: &Path, wav: &Path, language: &str) -> Result<Vec<Segment>, String> {
    let out_base = wav.with_extension("whisper");
    let output = Command::new(cli)
        .args([
            "-m",
            &model.to_string_lossy(),
            "-f",
            &wav.to_string_lossy(),
            "-oj",
            "-of",
            &out_base.to_string_lossy(),
            "-l",
            language,
        ])
        .output()
        .map_err(|err| format!("could not run whisper: {err}"))?;
    if !output.status.success() {
        return Err("whisper could not read this audio".to_string());
    }
    let json_path = PathBuf::from(format!("{}.json", out_base.to_string_lossy()));
    let raw = std::fs::read_to_string(&json_path).map_err(|_| "whisper produced no transcript".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|err| format!("bad transcript: {err}"))?;
    let mut segments = Vec::new();
    if let Some(items) = value.get("transcription").and_then(|item| item.as_array()) {
        for item in items {
            let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
            if text.is_empty() {
                continue;
            }
            let from = item
                .get("timestamps")
                .and_then(|t| t.get("from"))
                .and_then(|t| t.as_str())
                .map(parse_timestamp)
                .unwrap_or(0.0);
            let to = item
                .get("timestamps")
                .and_then(|t| t.get("to"))
                .and_then(|t| t.as_str())
                .map(parse_timestamp)
                .unwrap_or(from + 1.0);
            segments.push(Segment {
                start: from,
                end: to.max(from + 0.2),
                text,
                confidence: 0.9,
            });
        }
    }
    let _ = std::fs::remove_file(&json_path);
    Ok(segments)
}

const SAPI_SCRIPT: &str = r#"
param([string]$wav)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($wav)
$out = New-Object System.Collections.ArrayList
$cursor = 0.0
$deadline = (Get-Date).AddMinutes(20)
# Recognize() throws or blocks at end-of-file on some Windows builds, so bound every call.
while ((Get-Date) -lt $deadline) {
  try { $result = $engine.Recognize([TimeSpan]::FromMilliseconds(2500)) } catch { break }
  if ($result -eq $null) { break }
  # RecognizedAudio.StartTime is relative to each phrase (always 0), so time the results
  # sequentially instead — that keeps captions monotonic and in sync.
  $start = $cursor
  $duration = 1.0
  try { $duration = $result.Audio.Duration.TotalSeconds } catch { }
  $confidence = 0.55
  try { $confidence = $result.Confidence } catch { }
  $null = $out.Add([pscustomobject]@{
    start = [double]$start
    end = [double]($start + [Math]::Max(0.2, $duration))
    text = $result.Text
    confidence = [double]$confidence
  })
  $cursor = $start + [Math]::Max(0.2, $duration)
}
$engine.Dispose()
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
"#;

fn transcribe_sapi(wav: &Path, language: &str) -> Result<Vec<Segment>, String> {
    let temp_dir = std::env::temp_dir();
    let script_path = temp_dir.join("tacot-edit-sapi.ps1");
    std::fs::write(&script_path, SAPI_SCRIPT).map_err(|err| format!("could not stage recogniser: {err}"))?;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
            &wav.to_string_lossy(),
        ])
        .output()
        .map_err(|err| format!("could not start Windows speech recognition: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(format!(
                            "Windows speech recognition is unavailable{}. Install a Windows speech language pack, or reinstall Tacot Edit to restore the built-in speech model.",
            if tail.is_empty() { String::new() } else { format!(": {tail}") }
        ));
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "[]" {
        return Err("no speech was recognised in this audio".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|err| format!("bad recogniser output: {err}"))?;
    let items = value.as_array().cloned().unwrap_or_default();
    let mut segments = Vec::new();
    for item in items {
        let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let start = item.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let end = item.get("end").and_then(|v| v.as_f64()).unwrap_or(start + 1.0);
        segments.push(Segment {
            start,
            end: end.max(start + 0.2),
            text,
            confidence: item.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5),
        });
    }
    let _ = language;
    Ok(segments)
}

/// Transcribe a 16 kHz mono WAV. Prefers whisper.cpp when present, else Windows' built-in recogniser.
#[tauri::command]
pub fn transcribe(wav: String, language: Option<String>) -> Result<Transcript, String> {
    let path = PathBuf::from(&wav);
    if !path.is_file() {
        return Err("the extracted audio is missing".into());
    }
    let lang = language.unwrap_or_else(|| "en".to_string());
    if let Some((cli, model)) = speech_engine() {
        let segments = transcribe_whisper(&cli, &model, &path, &lang)?;
        let _ = std::fs::remove_file(&path);
        if !segments.is_empty() {
            return Ok(Transcript {
                engine: "On-device speech".into(),
                language: lang,
                segments,
            });
        }
    }
    let segments = transcribe_sapi(&path, &lang)?;
    let _ = std::fs::remove_file(&path);
    Ok(Transcript {
        engine: "Windows Speech".into(),
        language: lang,
        segments,
    })
}

const WHISPER_ZIP: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5907/whisper-bin-x64.zip";
const WHISPER_MODEL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

fn download(url: &str, dest: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-L", "--fail", "--silent", "--show-error", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|err| format!("could not start the download: {err}"))?;
    if !status.success() || !dest.is_file() {
        let _ = std::fs::remove_file(dest);
        return Err("the download did not finish — check your connection and try again".into());
    }
    Ok(())
}

fn flatten_whisper(dir: &Path) -> Result<(), String> {
    let mut found = None;
    if !dir.join("whisper-cli.exe").is_file() && !dir.join("main.exe").is_file() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && (path.join("whisper-cli.exe").is_file() || path.join("main.exe").is_file()) {
                    found = Some(path);
                    break;
                }
            }
        }
    }
    let Some(from) = found else { return Ok(()) };
    // The zip nests its binaries; move every file up so whisper_cli() finds them.
    if let Ok(entries) = std::fs::read_dir(&from) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let target = dir.join(entry.file_name());
                let _ = std::fs::copy(&path, &target);
            }
        }
    }
    Ok(())
}

/// Fetch whisper.cpp + a base English model into the app's whisper folder.
#[tauri::command]
pub async fn whisper_install() -> Result<EngineInfo, String> {
    let dir = PathBuf::from(whisper_dir()?);
    let zip = dir.join("whisper-bin.zip");
    if !dir.join("whisper-cli.exe").is_file() && !dir.join("main.exe").is_file() {
        download(WHISPER_ZIP, &zip)?;
        let script = format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            zip.display(),
            dir.display()
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .status()
            .map_err(|err| format!("could not unpack whisper: {err}"))?;
        let _ = std::fs::remove_file(&zip);
        if !status.success() {
            return Err("could not unpack whisper".into());
        }
        flatten_whisper(&dir)?;
    }
    if !dir.join("ggml-base.en.bin").is_file() {
        download(WHISPER_MODEL, &dir.join("ggml-base.en.bin"))?;
    }
    if speech_engine().is_none() {
        return Err("whisper was downloaded but the files are incomplete".into());
    }
    Ok(transcribe_engine())
}

#[tauri::command]
pub fn whisper_dir() -> Result<String, String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    let dir = PathBuf::from(base).join("Tacot Edit").join("bin").join("speech");
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create the speech folder: {err}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Which engine would run right now, for the UI to disclose before it starts.
#[derive(Serialize)]
pub struct EngineInfo {
    pub engine: String,
    pub detail: String,
    pub ready: bool,
}

#[tauri::command]
pub fn transcribe_engine() -> EngineInfo {
    match speech_engine() {
        Some((_cli, model)) => EngineInfo {
            engine: "On-device speech".into(),
            detail: format!(
                "Built in · {} · runs offline on this PC",
                model
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "model".into())
            ),
            ready: true,
        },
        None => EngineInfo {
            engine: "Windows Speech".into(),
            detail: "Basic offline dictation. Reinstall Tacot Edit to restore the built-in speech model for accurate captions.".into(),
            ready: false,
        },
    }
}
