use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct FfmpegInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(&local).join("Tacot Edit").join("bin").join("ffmpeg.exe"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        paths.push(PathBuf::from(&profile).join("ffmpeg").join("bin").join("ffmpeg.exe"));
    }
    paths.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
    paths.push(PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"));
    paths
}

/// FFmpeg that ships inside the installer, next to the executable. Checked first
/// so an outdated system copy can never shadow the bundled one.
fn bundled_ffmpeg() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(folder) = exe.parent() {
            paths.push(folder.join("bin").join("ffmpeg").join("ffmpeg.exe"));
            paths.push(folder.join("bin").join("ffmpeg.exe"));
            paths.push(folder.join("resources").join("bin").join("ffmpeg").join("ffmpeg.exe"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("Tacot Edit").join("bin").join("ffmpeg").join("ffmpeg.exe"));
    }
    paths
}

fn find_ffmpeg() -> Option<PathBuf> {
    if let Some(path) = bundled_ffmpeg().into_iter().find(|path| path.is_file()) {
        return Some(path);
    }
    if let Ok(path) = std::env::var("PATH") {
        for entry in std::env::split_paths(&path) {
            let candidate = entry.join("ffmpeg.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    candidate_paths().into_iter().find(|path| path.is_file())
}

#[tauri::command]
pub fn ffmpeg_check() -> FfmpegInfo {
    match find_ffmpeg() {
        Some(path) => {
            let version = Command::new(&path)
                .arg("-version")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string())
                .unwrap_or_default();
            FfmpegInfo {
                found: true,
                path: path.to_string_lossy().to_string(),
                version,
            }
        }
        None => FfmpegInfo {
            found: false,
            path: String::new(),
            version: String::new(),
        },
    }
}

/// Transcode a rendered WebM file to H.264/AAC MP4. Requires ffmpeg on this machine.
#[tauri::command]
pub fn ffmpeg_transcode(source: String, target: String) -> Result<String, String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "ffmpeg was not found on this computer".to_string())?;
    if !std::path::Path::new(&source).is_file() {
        return Err("the rendered file no longer exists".into());
    }
    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            &source,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            &target,
        ])
        .output()
        .map_err(|err| format!("could not run ffmpeg: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(4).collect::<Vec<_>>().join(" | ");
        return Err(format!("ffmpeg could not convert the file: {tail}"));
    }
    Ok(target)
}

/// Version of the running build, used by the optional update check.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Open a web link in the user's browser. Only http(s) is accepted, so a stray
/// value can never launch a local executable.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("only web links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|err| format!("could not open the link: {err}"))?;
    }
    Ok(())
}
