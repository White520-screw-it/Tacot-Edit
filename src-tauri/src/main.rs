#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod counter;
mod exporter;
mod media;
mod project;
mod tools;
mod transcribe;

use std::path::PathBuf;
use tauri::Manager;

/// Directories owned by the app, resolved once at startup.
pub struct AppDirs {
    pub data: PathBuf,
}

impl AppDirs {
    pub fn media(&self) -> PathBuf {
        self.data.join("media")
    }

    pub fn projects(&self) -> PathBuf {
        self.data.join("projects")
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            std::fs::create_dir_all(data.join("media"))?;
            std::fs::create_dir_all(data.join("projects"))?;

            app.manage(AppDirs { data: data.clone() });
            app.manage(exporter::ExportSink::default());
            app.manage(transcribe::TempSinks::default());
            counter::start(data.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media::media_import,
            media::media_import_path,
            media::media_path,
            media::media_sweep,
            project::project_save,
            project::project_load,
            project::project_list,
            project::autosave_write,
            project::autosave_read,
            project::project_delete,
            exporter::export_write,
            exporter::export_begin,
            exporter::export_chunk,
            exporter::export_finish,
            exporter::export_abort,
            exporter::export_remove,
            exporter::export_reveal,
            exporter::export_dir,
            tools::ffmpeg_check,
            tools::ffmpeg_transcode,
            tools::app_version,
            tools::open_url,
            transcribe::temp_begin,
            transcribe::temp_chunk,
            transcribe::temp_finish,
            transcribe::temp_discard,
            transcribe::transcribe,
            transcribe::transcribe_engine,
            transcribe::whisper_dir,
            transcribe::whisper_install,
        ])
        .run(tauri::generate_context!())
        .expect("Tacot Edit failed to start");
}
