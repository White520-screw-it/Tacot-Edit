use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APP: &str = "tacot-edit";

#[derive(Serialize, Deserialize, Default)]
struct CounterConfig {
    #[serde(rename = "counterUrl")]
    counter_url: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct CounterState {
    install_id: String,
    last_ping: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Install counters are intentionally inert: nothing is sent unless the owner
/// drops a `tacot.config.json` with a `counterUrl` next to the app data.
pub fn start(data_dir: PathBuf) {
    std::thread::spawn(move || {
        let config_path = data_dir.join("tacot.config.json");
        let config: CounterConfig = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();

        let url = match config.counter_url.filter(|url| url.starts_with("http")) {
            Some(url) => url,
            None => return,
        };

        let state_path = data_dir.join("counter.json");
        let mut state: CounterState = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();

        if state.install_id.is_empty() {
            state.install_id = format!("{:016x}{:08x}", now_secs(), std::process::id());
        }

        let now = now_secs();
        if now.saturating_sub(state.last_ping) < 60 * 60 * 24 {
            let _ = std::fs::write(&state_path, serde_json::to_string(&state).unwrap_or_default());
            return;
        }

        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };

        let body = serde_json::json!({
            "app": APP,
            "version": env!("CARGO_PKG_VERSION"),
            "install": state.install_id,
            "platform": std::env::consts::OS,
        });

        if client.post(&url).json(&body).send().map(|r| r.status().is_success()).unwrap_or(false) {
            state.last_ping = now;
            let _ = std::fs::write(&state_path, serde_json::to_string(&state).unwrap_or_default());
        }
    });
}
