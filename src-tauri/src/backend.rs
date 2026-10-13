use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const REMOTE_WINDOW: &str = "remote-backend";
const SETTINGS_WINDOW: &str = "backend-settings";
pub const LOGO_SCRIPT: &str = include_str!("../../desktop/backend-logo.js");
const MENU_URL: &str = "https://pi-desktop.invalid/backend-switcher";

#[derive(Default)]
pub struct SwitcherMenu(pub Mutex<Option<Menu<tauri::Wry>>>);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct BackendConfig {
    active: String,
    remotes: Vec<Remote>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Remote {
    name: String,
    url: String,
}
pub fn parse_url(value: &str) -> Result<Option<Url>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    let url = Url::parse(value.trim()).map_err(|_| "Enter a complete http:// or https:// URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Enter a complete http:// or https:// URL".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use the server URL without credentials, query parameters, or a fragment".into(),
        );
    }
    if url.path() != "/" {
        return Err("Use the server root URL, without a path such as /api".into());
    }
    Ok(Some(url))
}

impl BackendConfig {
    fn validate(&self) -> Result<(), String> {
        let mut urls = std::collections::HashSet::new();
        for remote in &self.remotes {
            if remote.name.trim().is_empty() || remote.name.chars().count() > 80 {
                return Err("Enter a name of 1–80 characters".into());
            }
            let url = parse_url(&remote.url)?.ok_or("A remote server needs a URL")?;
            if url.as_str() != remote.url || !urls.insert(&remote.url) {
                return Err("Saved backend URLs must be unique and normalized".into());
            }
        }
        if !self.active.is_empty() && !urls.contains(&self.active) {
            return Err("The selected backend is not saved".into());
        }
        Ok(())
    }

    fn save_remote(&mut self, name: &str, input: &str) -> Result<(), String> {
        let url = parse_url(input)?
            .ok_or("Enter a remote server URL")?
            .to_string();
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("Enter a name of 1–80 characters".into());
        }
        if let Some(remote) = self.remotes.iter_mut().find(|remote| remote.url == url) {
            remote.name = name.into();
        } else {
            self.remotes.push(Remote {
                name: name.into(),
                url,
            });
        }
        self.validate()
    }

    fn select(&mut self, url: &str) -> Result<(), String> {
        if !url.is_empty() && !self.remotes.iter().any(|remote| remote.url == url) {
            return Err("Choose a saved backend".into());
        }
        self.active = url.into();
        Ok(())
    }

    fn remove(&mut self, url: &str) -> Result<(), String> {
        if self.active == url {
            return Err("Switch away from this backend before removing it".into());
        }
        self.remotes.retain(|remote| remote.url != url);
        Ok(())
    }
}

fn write_config(dir: &Path, config: &BackendConfig) -> Result<(), String> {
    config.validate()?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let pending = dir.join("backends.json.tmp");
    fs::write(
        &pending,
        serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(pending, dir.join("backends.json")).map_err(|e| e.to_string())?;
    match fs::remove_file(dir.join("backend-url.txt")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn load_config(dir: &Path) -> Result<BackendConfig, String> {
    match fs::read(dir.join("backends.json")) {
        Ok(bytes) => {
            let config: BackendConfig = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved backend configuration is invalid")?;
            config.validate()?;
            Ok(config)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut config = BackendConfig::default();
            match fs::read_to_string(dir.join("backend-url.txt")) {
                Ok(value) => {
                    if let Some(url) = parse_url(&value)? {
                        config.save_remote(url.host_str().unwrap_or("Remote"), url.as_str())?;
                        config.select(url.as_str())?;
                    }
                    write_config(dir, &config)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            Ok(config)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

pub fn read(app: &AppHandle) -> Result<Option<Url>, String> {
    parse_url(&load_config(&config_dir(app)?)?.active)
}

pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        WebviewUrl::App("desktop-backend.html".into()),
    )
    .title("Backend Connections · 后端连接")
    .inner_size(560.0, 580.0)
    .min_inner_size(440.0, 480.0)
    .build()?;
    Ok(())
}

fn require_settings(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != SETTINGS_WINDOW {
        return Err("Unavailable in this window".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_backends(app: AppHandle, window: WebviewWindow) -> Result<BackendConfig, String> {
    require_settings(&window)?;
    load_config(&config_dir(&app)?)
}

#[tauri::command]
pub fn save_backend(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    url: String,
) -> Result<BackendConfig, String> {
    require_settings(&window)?;
    let dir = config_dir(&app)?;
    let mut config = load_config(&dir)?;
    config.save_remote(&name, &url)?;
    write_config(&dir, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn remove_backend(
    app: AppHandle,
    window: WebviewWindow,
    url: String,
) -> Result<BackendConfig, String> {
    require_settings(&window)?;
    let dir = config_dir(&app)?;
    let mut config = load_config(&dir)?;
    config.remove(&url)?;
    write_config(&dir, &config)?;
    Ok(config)
}

fn select_backend(app: &AppHandle, url: &str) -> Result<(), String> {
    let dir = config_dir(app)?;
    let loaded = load_config(&dir);
    let recovering = loaded.is_err();
    let mut config = match loaded {
        Ok(config) => config,
        Err(_) if url.is_empty() => BackendConfig::default(),
        Err(error) => return Err(error),
    };
    if !recovering && config.active == url {
        return Ok(());
    }
    config.select(url)?;
    write_config(&dir, &config)?;
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub fn activate_backend(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    require_settings(&window)?;
    select_backend(&app, &url)
}

pub fn menu_event(app: &AppHandle, id: &str) -> bool {
    if let Some(url) = id.strip_prefix("backend-select:") {
        if select_backend(app, url).is_err() {
            let _ = show_settings(app);
        }
        return true;
    }
    false
}

fn show_menu(app: &AppHandle, label: &str) -> Result<(), String> {
    let config = match load_config(&config_dir(app)?) {
        Ok(config) => config,
        Err(_) => return show_settings(app).map_err(|e| e.to_string()),
    };
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (url, title) in std::iter::once(("", "Local · 本地".to_string())).chain(
        config.remotes.iter().map(|remote| {
            (
                remote.url.as_str(),
                format!("{} — {}", remote.name, remote.url),
            )
        }),
    ) {
        let item = CheckMenuItem::with_id(
            app,
            format!("backend-select:{url}"),
            title.replace('&', "&&"),
            config.active != url,
            config.active == url,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }
    let manage = MenuItem::with_id(
        app,
        "settings-backend",
        "Manage backends… · 管理后端…",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&manage).map_err(|e| e.to_string())?;
    let notice = MenuItem::with_id(
        app,
        "backend-notice",
        "Switching restarts the app · 切换会重启应用",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&notice).map_err(|e| e.to_string())?;
    // Keep the menu alive on platforms where popup returns before dismissal.
    *app.state::<SwitcherMenu>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = Some(menu.clone());
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

pub fn intercept_navigation(app: &AppHandle, label: &str, url: &Url) -> bool {
    if url.as_str() != MENU_URL {
        return false;
    }
    let handle = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if show_menu(&handle, &label).is_err() {
            let _ = show_settings(&handle);
        }
    });
    true
}

pub fn build_remote_window(app: &AppHandle, url: Url) -> tauri::Result<WebviewWindow> {
    let origin = url.clone();
    let handle = app.clone();
    // A remote logo may open the native picker, but cannot read settings or select a server through IPC.
    WebviewWindowBuilder::new(app, REMOTE_WINDOW, WebviewUrl::External(url))
        .title("Pi Agent — Remote")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .disable_drag_drop_handler()
        .initialization_script(
            "Object.defineProperty(window, '__PI_REMOTE_BACKEND__', { value: true });",
        )
        .initialization_script(LOGO_SCRIPT)
        .on_navigation(move |url| {
            if intercept_navigation(&handle, REMOTE_WINDOW, url) {
                return false;
            }
            if super::same_origin(url, &origin) {
                true
            } else {
                super::open_external(url);
                false
            }
        })
        .on_new_window(|url, _| {
            super::open_external(&url);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}
#[cfg(test)]
mod tests {
    use super::parse_url;

    #[test]
    fn switching_and_renaming_preserve_saved_remotes() {
        let mut config = super::BackendConfig::default();
        config
            .save_remote("Office", " https://office.example ")
            .unwrap();
        config
            .save_remote("Home", "http://home.example:30141")
            .unwrap();
        config.select("https://office.example/").unwrap();
        config
            .save_remote("Office renamed", "https://office.example")
            .unwrap();
        assert_eq!(config.remotes.len(), 2);
        assert_eq!(config.remotes[0].name, "Office renamed");
        assert!(config.remove("https://office.example/").is_err());
        assert!(config.select("https://unknown.example/").is_err());
        assert_eq!(config.active, "https://office.example/");
        config.select("").unwrap();
        assert_eq!(config.remotes.len(), 2);
        config.remove("https://office.example/").unwrap();
        assert_eq!(config.remotes.len(), 1);
    }

    #[test]
    fn migrates_legacy_url_and_removes_old_source_of_truth() {
        let dir = std::env::temp_dir().join(format!(
            "pi-backends-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("backend-url.txt"), "https://office.example").unwrap();
        let mut config = super::load_config(&dir).unwrap();
        assert_eq!(config.active, "https://office.example/");
        assert_eq!(config.remotes.len(), 1);
        assert!(!dir.join("backend-url.txt").exists());
        config.select("").unwrap();
        super::write_config(&dir, &config).unwrap();
        assert_eq!(super::load_config(&dir).unwrap(), config);
        std::fs::write(dir.join("backends.json"), "broken").unwrap();
        assert!(super::load_config(&dir).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("backends.json")).unwrap(),
            "broken"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_local_default_and_http_origins() {
        assert_eq!(parse_url(" \n").unwrap(), None);
        for input in [
            "https://pi.example.com",
            " http://localhost:30141/ ",
            "http://[::1]:30141",
        ] {
            assert!(parse_url(input).unwrap().is_some());
        }
        assert_eq!(
            parse_url(" https://pi.example.com ")
                .unwrap()
                .unwrap()
                .as_str(),
            "https://pi.example.com/"
        );
    }

    #[test]
    fn rejects_non_server_urls_and_embedded_secrets() {
        for input in [
            "pi.example.com",
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://user:secret@host",
            "https://host/?token=secret",
            "https://host/#token",
            "https://host/api",
            "https://host/chat/123",
        ] {
            assert!(parse_url(input).is_err(), "{input}");
        }
    }
}
