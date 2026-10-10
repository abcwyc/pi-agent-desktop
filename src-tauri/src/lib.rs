use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

#[cfg(not(target_os = "linux"))]
use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItem as MacMenuItem, PredefinedMenuItem, Submenu};
#[cfg(not(target_os = "linux"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(not(target_os = "macos"))]
use tauri::webview::Color;
use tauri::{
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const WINDOW_LABEL: &str = "main";
const DESKTOP_API_TOKEN_ENV: &str = "PI_DESKTOP_API_TOKEN";
const DESKTOP_INSTANCE_ID_ENV: &str = "PI_DESKTOP_INSTANCE_ID";
const DESKTOP_INSTANCE_ID_HEADER: &str = "x-pi-desktop-instance";
#[cfg(not(feature = "custom-protocol"))]
const DEV_SERVER_URL: &str = "http://127.0.0.1:30141";
/// Preferred localhost port for the packaged Next server. Keeping this stable
/// matters because the webview's localStorage is origin-scoped (`host:port`).
#[cfg(feature = "custom-protocol")]
const DESKTOP_SERVER_PORT: u16 = 38471;
#[cfg(feature = "custom-protocol")]
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(not(target_os = "macos"))]
const LIGHT_WINDOW_BG: Color = Color(247, 247, 245, 255);
#[cfg(not(target_os = "macos"))]
const DARK_WINDOW_BG: Color = Color(28, 28, 30, 255);

struct DesktopServer {
    child: Mutex<Option<Child>>,
}

/// When true, closing the main window quits the app; otherwise it hides to tray.
struct CloseQuits(Mutex<bool>);

struct DesktopApiToken(String);

fn generate_random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn load_or_generate_desktop_api_token() -> Result<String, String> {
    if let Ok(value) = env::var(DESKTOP_API_TOKEN_ENV) {
        let value = value.trim();
        if value.len() >= 32 {
            return Ok(value.to_string());
        }
    }

    generate_random_hex()
}

#[tauri::command]
fn get_desktop_api_token(token: tauri::State<'_, DesktopApiToken>) -> String {
    token.0.clone()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn build_macos_app_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_name = app.package_info().name.clone();
    let new_session =
        MacMenuItem::with_id(app, "new-session", "New Session", true, Some("CmdOrCtrl+N"))?;
    let general_settings = MacMenuItem::with_id(
        app,
        "settings-general",
        "General Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let model_settings = MacMenuItem::with_id(
        app,
        "settings-models",
        "Model Settings…",
        true,
        Some("CmdOrCtrl+M"),
    )?;
    let about = PredefinedMenuItem::about(app, None, None)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let app_menu = Submenu::with_items(
        app,
        app_name,
        true,
        &[
            &about,
            &separator,
            &services,
            &separator,
            &hide,
            &hide_others,
            &separator,
            &quit,
        ],
    )?;
    let file_menu = Submenu::with_items(app, "File", true, &[&new_session])?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let settings_menu =
        Submenu::with_items(app, "Settings", true, &[&general_settings, &model_settings])?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &settings_menu,
            &view_menu,
            &window_menu,
        ],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

fn quit_application(app: &AppHandle) {
    if let Some(server) = app.try_state::<DesktopServer>() {
        server.stop();
    }
    app.exit(0);
}

#[cfg(target_os = "linux")]
const LINUX_TRAY_SHOW_LABEL: &str = "Show Pi Agent";
#[cfg(target_os = "linux")]
const LINUX_TRAY_QUIT_LABEL: &str = "Quit Pi Agent";

#[cfg(target_os = "linux")]
struct LinuxTray {
    app: AppHandle,
    icon: ksni::Icon,
}

#[cfg(target_os = "linux")]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        "pi-agent-desktop".into()
    }

    fn title(&self) -> String {
        "Pi Agent".into()
    }

    fn icon_name(&self) -> String {
        "pi-agent-desktop".into()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "Pi Agent".into(),
            ..Default::default()
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        show_main_window_on_main_thread(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        let show_app = self.app.clone();
        let quit_app = self.app.clone();

        vec![
            visible_linux_tray_item(LINUX_TRAY_SHOW_LABEL, move |_| {
                show_main_window_on_main_thread(&show_app)
            }),
            visible_linux_tray_item(LINUX_TRAY_QUIT_LABEL, move |_| {
                quit_application_on_main_thread(&quit_app)
            }),
        ]
    }
}

#[cfg(target_os = "linux")]
fn visible_linux_tray_item<T: 'static>(
    label: &str,
    activate: impl Fn(&mut T) + 'static,
) -> ksni::MenuItem<T> {
    ksni::menu::StandardItem {
        label: label.into(),
        enabled: true,
        visible: true,
        activate: Box::new(activate),
        ..Default::default()
    }
    .into()
}

#[cfg(target_os = "linux")]
fn show_main_window_on_main_thread(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || show_main_window(&app_handle));
}

#[cfg(target_os = "linux")]
fn quit_application_on_main_thread(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || quit_application(&app_handle));
}

#[cfg(target_os = "linux")]
fn linux_tray_icon(icon: &tauri::image::Image<'_>) -> ksni::Icon {
    let mut data = Vec::with_capacity(icon.rgba().len());
    for rgba in icon.rgba().chunks_exact(4) {
        data.extend_from_slice(&[rgba[3], rgba[0], rgba[1], rgba[2]]);
    }

    ksni::Icon {
        width: icon.width() as i32,
        height: icon.height() as i32,
        data,
    }
}

#[cfg(target_os = "linux")]
fn build_linux_tray(app: &tauri::App) -> Result<(), std::io::Error> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("missing default window icon"))?;
    let service = ksni::TrayService::new(LinuxTray {
        app: app.handle().clone(),
        icon: linux_tray_icon(icon),
    });

    std::thread::spawn(move || {
        if let Err(error) = service.run() {
            eprintln!("Pi Agent Linux tray stopped: {error}");
        }
    });
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn build_platform_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Pi Agent", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Pi Agent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("missing default window icon"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Pi Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

impl DesktopServer {
    #[cfg(not(feature = "custom-protocol"))]
    fn empty() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    fn running(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    fn stop(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        let Some(child) = guard.take() else {
            return;
        };

        terminate_process_tree(child);
    }
}

fn terminate_process_tree(mut child: Child) {
    #[cfg(unix)]
    {
        let pid = child.id();
        unsafe {
            // The Node server owns its process group, so this also stops any
            // agent/tool subprocesses that are active when the App quits.
            libc::kill(-(pid as i32), libc::SIGTERM);
        }

        // Reap on a detached thread so the quit/exit path never blocks on the
        // Node server's shutdown. The packaged server installs no SIGTERM
        // handler, so it normally dies immediately, but any child that ignores
        // SIGTERM must not stall the UI for the full grace window. If the main
        // process exits before this thread finishes, the server's own parent
        // watchdog (desktop/server-launcher.cjs) exits it within ~1 s, so no
        // orphan is left behind either way.
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => return,
                }
            }

            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        });
    }

    #[cfg(windows)]
    {
        // taskkill /T terminates the packaged Node server and any agent/tool
        // subprocesses it started. CREATE_NO_WINDOW avoids flashing a console.
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url.as_str()).spawn();
    }
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe applies the default file association without going
        // through the cmd parser, where `&` or `^` in an otherwise legal path
        // (`C:\src\R&D\notes.txt`) would be read as a command separator.
        Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening local paths is unsupported on this platform".into())
}

fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .args(["-R"])
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Reveal in folder is unsupported on this platform".into())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only http, https, and mailto URLs can be opened externally".into());
    }
    open_external(&parsed);
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_path_with_default_app(Path::new(&path))
}

#[tauri::command]
fn reveal_item_in_dir(path: String) -> Result<(), String> {
    reveal_path_in_file_manager(Path::new(&path))
}

/// Launch Services' answer to Finder's "Open With": every application that can
/// open `argv[0]`, the default one first. Nested bundles (Xcode's Instruments)
/// and cache copies (Playwright's Chrome for Testing) are noise in a context
/// menu, so they are dropped here rather than in the UI. The path travels as
/// an argument, never spliced into the script.
#[cfg(target_os = "macos")]
const LIST_APPS_FOR_FILE_JXA: &str = r#"
ObjC.import("AppKit");
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const workspace = $.NSWorkspace.sharedWorkspace;
  const fileManager = $.NSFileManager.defaultManager;
  const preferred = workspace.URLForApplicationToOpenURL(url);
  const preferredPath = preferred ? ObjC.unwrap(preferred.path) : null;
  const urls = workspace.URLsForApplicationsToOpenURL(url);
  const seen = {};
  const apps = [];
  for (let i = 0; i < urls.count; i++) {
    const appPath = ObjC.unwrap(urls.objectAtIndex(i).path);
    if (seen[appPath]) continue;
    seen[appPath] = true;
    if (appPath.slice(0, -4).indexOf(".app/") !== -1) continue;
    if (appPath.indexOf("/Library/Caches/") !== -1) continue;
    apps.push({
      name: ObjC.unwrap(fileManager.displayNameAtPath(appPath)),
      path: appPath,
      isDefault: appPath === preferredPath,
    });
  }
  apps.sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
  return JSON.stringify(apps.slice(0, 40));
}
"#;

#[cfg(target_os = "macos")]
fn list_apps_for_file_macos(path: &Path) -> Result<serde_json::Value, String> {
    if !path.is_absolute() {
        return Err("An absolute path is required".into());
    }
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    let output = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", LIST_APPS_FOR_FILE_JXA])
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn open_path_with_app_macos(path: &Path, app: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("An absolute path is required".into());
    }
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    let is_app_bundle = app.is_absolute()
        && app.is_dir()
        && app
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    if !is_app_bundle {
        return Err(format!("Not an application bundle: {}", app.display()));
    }
    let output = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Applications that can open `path`, default first. Empty off macOS, where the
/// UI offers no "Open With" menu yet.
#[tauri::command]
async fn list_apps_for_file(path: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        // osascript takes ~150ms; keep it off the IPC thread.
        return tauri::async_runtime::spawn_blocking(move || {
            list_apps_for_file_macos(Path::new(&path))
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    {
        let _ = path;
        Ok(serde_json::Value::Array(Vec::new()))
    }
}

/// Opens `path` with the application bundle at `app` (Finder's "Open With").
#[tauri::command]
async fn open_path_with(path: String, app: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            open_path_with_app_macos(Path::new(&path), Path::new(&app))
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    {
        let _ = (path, app);
        Err("Open With is only supported on macOS".into())
    }
}

/// One entry of a popup menu, as the UI describes it. The menu is built here,
/// from this plain data, instead of through the JS menu API: that API keeps the
/// menu and its items as resources the page holds, routes clicks back through
/// JS channels, and its `popup` command holds the webview's resource-table lock
/// while the main thread runs the menu. A menu that never leaves Rust has none
/// of that to deadlock on.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PopupMenuEntry {
    Item {
        id: String,
        text: String,
        enabled: bool,
        checked: Option<bool>,
    },
    Separator,
    Submenu {
        text: String,
        enabled: bool,
        items: Vec<PopupMenuEntry>,
    },
    Predefined {
        item: String,
        text: Option<String>,
    },
}

/// Where a popup menu's selected item is delivered. The menu's click arrives as
/// an app-level menu event (some platforms deliver it after the popup call has
/// returned), so the command parks a sender here and waits for it.
#[derive(Default)]
struct PopupMenuSelection(Mutex<Option<std::sync::mpsc::Sender<String>>>);

const POPUP_ID_PREFIX: &str = "popup:";
/// How long to wait for the click after the popup call returns.
const POPUP_SELECTION_GRACE: Duration = Duration::from_millis(400);
const DESKTOP_LOG_MAX_BYTES: u64 = 256 * 1024;

/// Appends a line to `desktop.log` in the app log directory. Best effort: the
/// log exists so a hang during a popup leaves the last step on disk.
fn desktop_log(app: &AppHandle, message: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("desktop.log");
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > DESKTOP_LOG_MAX_BYTES) {
        let _ = fs::remove_file(&path);
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{millis} {message}");
    }
}

fn build_popup_items(
    app: &AppHandle,
    nonce: u64,
    entries: &[PopupMenuEntry],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};

    let mut out: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry {
            PopupMenuEntry::Item { id, text, enabled, checked } => {
                let menu_id = format!("{POPUP_ID_PREFIX}{nonce}:{id}");
                match checked {
                    Some(checked) => out.push(Box::new(CheckMenuItem::with_id(
                        app, menu_id, text, *enabled, *checked, None::<&str>,
                    )?)),
                    None => out.push(Box::new(MenuItem::with_id(
                        app, menu_id, text, *enabled, None::<&str>,
                    )?)),
                }
            }
            PopupMenuEntry::Separator => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            PopupMenuEntry::Submenu { text, enabled, items } => {
                let children = build_popup_items(app, nonce, items)?;
                let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
                    children.iter().map(|item| item.as_ref()).collect();
                out.push(Box::new(Submenu::with_items(app, text, *enabled, &refs)?));
            }
            PopupMenuEntry::Predefined { item, text } => {
                let text = text.as_deref();
                let built = match item.as_str() {
                    "Copy" => PredefinedMenuItem::copy(app, text)?,
                    "Cut" => PredefinedMenuItem::cut(app, text)?,
                    "Paste" => PredefinedMenuItem::paste(app, text)?,
                    "SelectAll" => PredefinedMenuItem::select_all(app, text)?,
                    "Undo" => PredefinedMenuItem::undo(app, text)?,
                    "Redo" => PredefinedMenuItem::redo(app, text)?,
                    _ => continue,
                };
                out.push(Box::new(built));
            }
        }
    }
    Ok(out)
}

/// Shows `items` as a native popup menu and resolves to the id of the item the
/// user picked, or `None` when it was dismissed. Nothing runs while the menu is
/// open except the menu itself: the page gets the answer afterwards.
#[tauri::command]
async fn show_popup_menu(
    app: AppHandle,
    window: tauri::Window,
    items: Vec<PopupMenuEntry>,
    at: Option<tauri::LogicalPosition<f64>>,
) -> Result<Option<String>, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::menu::{ContextMenu as _, Menu};

    static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);
    let nonce = NEXT_NONCE.fetch_add(1, Ordering::Relaxed);

    // The item boxes are not `Send`; they must be gone before the first await.
    let menu = {
        let built = build_popup_items(&app, nonce, &items).map_err(|error| error.to_string())?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            built.iter().map(|item| item.as_ref()).collect();
        Menu::with_items(&app, &refs).map_err(|error| error.to_string())?
    };

    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    if let Some(state) = app.try_state::<PopupMenuSelection>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(sender);
        }
    }

    desktop_log(&app, &format!("popup #{nonce} open ({} entries)", items.len()));
    let started = Instant::now();
    // Blocks until the menu is dismissed; keep it off the shared async pool.
    let popup = tauri::async_runtime::spawn_blocking(move || match at {
        Some(position) => menu.popup_at(window, position),
        None => menu.popup(window),
    })
    .await
    .map_err(|error| error.to_string())?;
    desktop_log(
        &app,
        &format!("popup #{nonce} closed after {}ms", started.elapsed().as_millis()),
    );
    popup.map_err(|error| error.to_string())?;

    let wanted = format!("{POPUP_ID_PREFIX}{nonce}:");
    let chosen = receiver
        .recv_timeout(POPUP_SELECTION_GRACE)
        .ok()
        .and_then(|id| id.strip_prefix(&wanted).map(str::to_string));
    if let Some(state) = app.try_state::<PopupMenuSelection>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = None;
        }
    }
    desktop_log(&app, &format!("popup #{nonce} selected {chosen:?}"));
    Ok(chosen)
}

#[tauri::command]
fn set_close_quits(app: AppHandle, quit: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<CloseQuits>() {
        *state
            .0
            .lock()
            .map_err(|_| "close-behavior lock poisoned".to_string())? = quit;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    quit_application(&app);
    Ok(())
}

#[tauri::command]
fn show_main_window_cmd(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

/// Persist the UI theme outside the webview origin so cold starts keep the
/// user's light/dark choice even when the local server port changes.
#[tauri::command]
fn set_ui_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let theme =
        normalize_theme(&theme).ok_or_else(|| "theme must be \"light\" or \"dark\"".to_string())?;
    write_ui_prefs_theme(&app, theme)?;
    apply_window_theme(&app, theme);
    Ok(())
}

fn ui_prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("ui-prefs.json"))
}

fn normalize_theme(theme: &str) -> Option<&'static str> {
    match theme {
        "light" => Some("light"),
        "dark" => Some("dark"),
        _ => None,
    }
}

fn read_ui_prefs(app: &AppHandle) -> serde_json::Value {
    let Ok(path) = ui_prefs_path(app) else {
        return serde_json::json!({});
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_ui_prefs(app: &AppHandle, prefs: &serde_json::Value) -> Result<(), String> {
    let path = ui_prefs_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(prefs).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

/// The build's version (from Cargo.toml), known at compile time.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Path to a small JSON file recording the version that last ran successfully.
fn last_version_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("last-version.json"))
}

fn read_last_version(app: &AppHandle) -> Option<String> {
    let path = last_version_path(app).ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn write_last_version(app: &AppHandle) {
    if let Ok(path) = last_version_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let raw = serde_json::json!({ "version": APP_VERSION });
        if let Ok(body) = serde_json::to_string_pretty(&raw) {
            let _ = fs::write(path, body);
        }
    }
}

/// Clear webview disk caches whose entries are hashed by build (Next.js asset
/// chunks, WebKit HTTP cache, WebView2 partition cache). Stale entries from a
/// previous version still resolve to the old hashed filenames and 404 after an
/// upgrade, which on WebKitGTK surfaces as a hard "This page couldn't load"
/// error page on the next navigation.
///
/// Only the cache directories are touched — `localStorage`, sessions, and
/// user settings live elsewhere and are preserved.
fn clear_webview_caches(app: &AppHandle) {
    // Linux WebKitGTK: ~/.local/share/<identifier>/WebKitCache
    #[cfg(target_os = "linux")]
    if let Ok(data_dir) = app.path().app_data_dir() {
        let webkit_cache = data_dir.join("WebKitCache");
        if webkit_cache.is_dir() {
            let _ = fs::remove_dir_all(&webkit_cache);
        }
    }
    // Windows WebView2: cache partition under the app data dir.
    #[cfg(target_os = "windows")]
    if let Ok(data_dir) = app.path().app_data_dir() {
        let webview2 = data_dir.join("EBWebView");
        if webview2.is_dir() {
            for entry in fs::read_dir(&webview2).into_iter().flatten().flatten() {
                let cache_dir = entry.path().join("Cache");
                if cache_dir.is_dir() {
                    let _ = fs::remove_dir_all(&cache_dir);
                }
            }
        }
    }
    // macOS WKWebView: per-origin caches under ~/Library/WebKit/<identifier>.
    #[cfg(target_os = "macos")]
    if let Ok(config_dir) = app.path().app_config_dir() {
        // app_config_dir on macOS is ~/Library/Application Support/<identifier>;
        // WKWebView WebsiteKit caches live under ~/Library/WebKit/<bundle-id>.
        if let Some(home) = dirs_home_dir() {
            let wk = home.join("Library/WebKit/com.abcwyc.pi-agent");
            if wk.is_dir() {
                let _ = fs::remove_dir_all(&wk);
            }
        }
        let _ = config_dir; // suppress unused on non-mac
    }
}

#[cfg(target_os = "macos")]
fn dirs_home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

/// Detect a version change since the last successful launch and, when one is
/// found, clear stale webview caches before the window loads. The current
/// version is recorded *after* the window is built so a crash during startup
/// keeps flagging a cache clear on the next run.
fn reconcile_webview_cache_for_version(app: &AppHandle) {
    let last = read_last_version(app);
    if last.as_deref() != Some(APP_VERSION) {
        clear_webview_caches(app);
    }
}

fn read_stored_theme(app: &AppHandle) -> Option<&'static str> {
    read_ui_prefs(app)
        .get("theme")
        .and_then(|value| value.as_str())
        .and_then(normalize_theme)
}

fn write_ui_prefs_theme(app: &AppHandle, theme: &str) -> Result<(), String> {
    let mut prefs = read_ui_prefs(app);
    prefs["theme"] = serde_json::Value::String(theme.to_string());
    write_ui_prefs(app, &prefs)
}

#[cfg(feature = "custom-protocol")]
fn read_last_server_port(app: &AppHandle) -> Option<u16> {
    read_ui_prefs(app)
        .get("serverPort")
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

#[cfg(feature = "custom-protocol")]
fn write_last_server_port(app: &AppHandle, port: u16) {
    let mut prefs = read_ui_prefs(app);
    prefs["serverPort"] = serde_json::Value::from(port);
    let _ = write_ui_prefs(app, &prefs);
}

#[cfg(not(target_os = "macos"))]
fn theme_background_color(theme: &str) -> Color {
    if theme == "dark" {
        DARK_WINDOW_BG
    } else {
        LIGHT_WINDOW_BG
    }
}

fn theme_bootstrap_script(theme: &str) -> String {
    // Runs before page scripts so localStorage/class match the persisted
    // preference even on a fresh webview origin (new localhost port). The
    // native pref is only seeded into localStorage when the origin has no
    // choice recorded yet: the renderer writes "pi-theme" before it invokes
    // `set_ui_theme`, so localStorage is always the freshest user intent and
    // must never be clobbered by a (possibly stale) native pref — e.g. after
    // a crash interrupted the toggle before the IPC round-trip landed.
    format!(
        r#"(function(){{try{{var t=localStorage.getItem("pi-theme");if(!t){{t="{theme}";localStorage.setItem("pi-theme",t);}}var d=t==="dark";document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}}catch(e){{}}}})();"#
    )
}

/// True when running under a Wayland compositor. `set_background_color` and a
/// few other native chrome APIs dereference a null GdkSurface there and crash,
/// so callers consult this to avoid them.
#[cfg(not(target_os = "macos"))]
fn is_wayland() -> bool {
    env::var("WAYLAND_DISPLAY").is_ok()
        || env::var("GDK_BACKEND")
            .map(|value| value.contains("wayland"))
            .unwrap_or(false)
}

fn apply_window_theme(app: &AppHandle, theme: &str) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let tauri_theme = if theme == "dark" {
        Theme::Dark
    } else {
        Theme::Light
    };
    let _ = window.set_theme(Some(tauri_theme));
    // `set_background_color` dereferences a possibly-null GdkSurface under
    // Wayland and segfaults the whole process (frameless WebKitGTK window).
    // The page paints its own opaque background via CSS, so the native chrome
    // color is cosmetic only and is safe to skip on Wayland.
    // On macOS the window is transparent over an NSVisualEffectView, so an
    // opaque native background would hide the vibrancy.
    #[cfg(not(target_os = "macos"))]
    if !is_wayland() {
        let _ = window.set_background_color(Some(theme_background_color(theme)));
    }
}

fn same_origin(candidate: &Url, app_url: &Url) -> bool {
    candidate.scheme() == app_url.scheme()
        && candidate.host_str() == app_url.host_str()
        && candidate.port_or_known_default() == app_url.port_or_known_default()
}

fn build_window(app: &tauri::AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let navigation_origin = app_url.clone();
    let stored_theme = read_stored_theme(app);

    let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
        .title("Pi Agent")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        // Pi Agent already handles browser drag/drop for image attachments.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if same_origin(url, &navigation_origin) {
                true
            } else {
                open_external(url);
                false
            }
        })
        .on_new_window(|url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });

    // Force the native window chrome/background to match an explicit UI theme
    // before the page paints — otherwise macOS dark mode flashes a black
    // webview while the user has chosen light mode.
    if let Some(theme) = stored_theme {
        let tauri_theme = if theme == "dark" {
            Theme::Dark
        } else {
            Theme::Light
        };
        builder = builder
            .theme(Some(tauri_theme))
            .initialization_script(theme_bootstrap_script(theme));
        // Skip the native background color on Wayland: it can NULL-deref the
        // GdkSurface during window creation and crash the process.
        #[cfg(not(target_os = "macos"))]
        if !is_wayland() {
            builder = builder.background_color(theme_background_color(theme));
        }
    }

    // Lets native-theme.css apply desktop-only conventions (arrow cursors,
    // non-selectable chrome) without touching the browser build.
    builder = builder.initialization_script(DESKTOP_MARKER_SCRIPT);

    // Hide the native title bar. macOS keeps the traffic-light controls
    // (overlaid on our own top bar); other platforms go fully frameless and
    // rely on custom window controls drawn in the web content instead.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // Transparent webview over an NSVisualEffectView (see below). The
            // `native-vibrancy` class tells native-theme.css to let the sidebar
            // show through; without it the page paints opaque as before.
            .transparent(true)
            .initialization_script(VIBRANCY_MARKER_SCRIPT);
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    apply_macos_vibrancy(&window);

    Ok(window)
}

const DESKTOP_MARKER_SCRIPT: &str =
    r#"(function(){try{document.documentElement.classList.add("native-desktop");}catch(e){}})();"#;

/// Marks <html> so native-theme.css can make the sidebar translucent. Removed
/// again by `apply_macos_vibrancy` if the effect view could not be attached.
#[cfg(target_os = "macos")]
const VIBRANCY_MARKER_SCRIPT: &str =
    r#"(function(){try{document.documentElement.classList.add("native-vibrancy");}catch(e){}})();"#;

/// Puts the system sidebar material behind the transparent webview. The
/// material follows the window theme set via `set_theme`.
#[cfg(target_os = "macos")]
fn apply_macos_vibrancy(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    if apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    )
    .is_err()
    {
        let _ = window.eval(
            r#"document.documentElement.classList.remove("native-vibrancy");"#,
        );
    }
}

#[cfg(all(feature = "custom-protocol", unix))]
fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(shell)
        .args(["-l", "-c", "/usr/bin/env"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("PATH="))
        .map(str::to_string)
        .filter(|path| !path.is_empty())
}

#[cfg(all(feature = "custom-protocol", windows))]
fn login_shell_path() -> Option<String> {
    env::var("PATH").ok().filter(|path| !path.is_empty())
}

#[cfg(all(feature = "custom-protocol", target_os = "macos"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/Pi Agent Server.app/Contents/MacOS/node")
}

#[cfg(all(feature = "custom-protocol", target_os = "windows"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/node/node.exe")
}

#[cfg(all(feature = "custom-protocol", target_os = "linux"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    // Resolution order: explicit override (distro packs point this at their
    // own node, e.g. Nix store or /opt prefixes) > bundled runtime > the FHS
    // default. Next.js requires Node >= 20.9.
    if let Ok(p) = env::var("PI_DESKTOP_NODE") {
        let path = PathBuf::from(&p);
        if !p.is_empty() && path.is_file() {
            return path;
        }
    }
    let bundled = resource_dir.join("resources/node/node");
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("/usr/bin/node")
    }
}

#[cfg(feature = "custom-protocol")]
fn child_process_compatible_path(path: &Path) -> PathBuf {
    // Tauri resolves its Windows resource directory from a canonicalized
    // executable path. `std::fs::canonicalize` uses the verbatim `\\?\C:\...`
    // form on Windows, but Node's entry-point resolver is not verbatim-path
    // aware and reduces that argument to the bare drive (`C:`). Simplify the
    // path before it crosses the process boundary. On non-Windows platforms
    // this is intentionally a no-op.
    dunce::simplified(path).to_path_buf()
}

#[cfg(feature = "custom-protocol")]
fn server_process_path(node_path: &Path) -> Option<std::ffi::OsString> {
    let inherited = login_shell_path().unwrap_or_default();
    let mut paths = vec![node_path.parent()?.to_path_buf()];
    paths.extend(env::split_paths(&inherited));
    env::join_paths(paths).ok()
}

#[cfg(feature = "custom-protocol")]
fn choose_port(app: &AppHandle) -> io::Result<u16> {
    let mut candidates = Vec::with_capacity(36);
    if let Some(last) = read_last_server_port(app) {
        candidates.push(last);
    }
    candidates.push(DESKTOP_SERVER_PORT);
    for offset in 1u16..=32 {
        candidates.push(DESKTOP_SERVER_PORT.saturating_add(offset));
    }

    for port in candidates {
        if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            let chosen = listener.local_addr()?.port();
            drop(listener);
            write_last_server_port(app, chosen);
            return Ok(chosen);
        }
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let chosen = listener.local_addr()?.port();
    drop(listener);
    write_last_server_port(app, chosen);
    Ok(chosen)
}

#[cfg(feature = "custom-protocol")]
fn response_has_instance_id(response: &[u8], expected_instance_id: &str) -> bool {
    let Ok(response) = std::str::from_utf8(response) else {
        return false;
    };
    let Some((headers, _)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut lines = headers.lines();
    let Some(status) = lines.next() else {
        return false;
    };
    if !(status.starts_with("HTTP/1.1 204 ") || status.starts_with("HTTP/1.0 204 ")) {
        return false;
    }

    lines.any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case(DESKTOP_INSTANCE_ID_HEADER)
                && value.trim() == expected_instance_id
        })
    })
}

#[cfg(feature = "custom-protocol")]
fn server_identity_matches(address: SocketAddr, expected_instance_id: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }

    let request = format!(
        "GET /api/desktop/identity HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 512];
    while response.len() < 8 * 1024 {
        let Ok(read) = stream.read(&mut chunk) else {
            return false;
        };
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    response_has_instance_id(&response, expected_instance_id)
}

#[cfg(feature = "custom-protocol")]
fn wait_for_server(
    child: &mut Child,
    address: SocketAddr,
    expected_instance_id: &str,
    log_path: &Path,
) -> io::Result<()> {
    let deadline = Instant::now() + SERVER_START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "Pi Agent server exited early with {status}; see {}",
                log_path.display()
            )));
        }
        if server_identity_matches(address, expected_instance_id) {
            // Re-check after the HTTP handshake. A losing child can exit with
            // EADDRINUSE while another process is answering on the same port.
            if let Some(status) = child.try_wait()? {
                return Err(io::Error::other(format!(
                    "Pi Agent server exited during startup with {status}; see {}",
                    log_path.display()
                )));
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "Pi Agent server did not start within {} seconds; see {}",
            SERVER_START_TIMEOUT.as_secs(),
            log_path.display()
        ),
    ))
}

#[cfg(feature = "custom-protocol")]
fn start_packaged_server(
    app: &tauri::AppHandle,
    desktop_api_token: &str,
    desktop_instance_id: &str,
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    let resource_dir = child_process_compatible_path(&app.path().resource_dir()?);
    let node_path = bundled_node_path(&resource_dir);
    if !node_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Node.js runtime is missing: {} (Linux: set PI_DESKTOP_NODE or install 'nodejs')",
                node_path.display()
            ),
        )
        .into());
    }

    let server_dir = resource_dir.join("resources/server");
    let server_script = server_dir.join("desktop-server.cjs");
    if !server_script.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Bundled Next.js server is missing: {}",
                server_script.display()
            ),
        )
        .into());
    }

    let log_dir = app.path().app_log_dir()?;
    fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("server.log");
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let stderr = stdout.try_clone()?;

    let port = choose_port(app)?;
    let mut command = Command::new(&node_path);
    command
        .arg(&server_script)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("PI_WEB_PARENT_PID", std::process::id().to_string())
        .env(DESKTOP_API_TOKEN_ENV, desktop_api_token)
        .env(DESKTOP_INSTANCE_ID_ENV, desktop_instance_id)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if let Some(path) = server_process_path(&node_path) {
        command.env("PATH", path);
    }

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn()?;

    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    if let Err(error) = wait_for_server(&mut child, address, desktop_instance_id, &log_path) {
        let server = DesktopServer::running(child);
        server.stop();
        return Err(error.into());
    }

    let url = format!("http://127.0.0.1:{port}").parse()?;
    Ok((url, DesktopServer::running(child)))
}

#[cfg(all(test, feature = "custom-protocol"))]
mod tests {
    use super::{child_process_compatible_path, response_has_instance_id, PopupMenuEntry};
    #[cfg(target_os = "linux")]
    use super::{visible_linux_tray_item, LinuxTray, LINUX_TRAY_QUIT_LABEL, LINUX_TRAY_SHOW_LABEL};
    use std::path::{Path, PathBuf};

    #[test]
    fn popup_menu_entries_parse_the_shape_the_ui_sends() {
        // Mirrors `toPopupSpec` in lib/desktop-menu-model.ts.
        let entries: Vec<PopupMenuEntry> = serde_json::from_str(
            r#"[
                {"kind":"item","id":"0","text":"Open","enabled":true},
                {"kind":"item","id":"1","text":"Pinned","enabled":false,"checked":true},
                {"kind":"separator"},
                {"kind":"submenu","text":"Open With","enabled":true,"items":[
                    {"kind":"item","id":"2","text":"Editor","enabled":true}
                ]},
                {"kind":"predefined","item":"Copy"},
                {"kind":"predefined","item":"Paste","text":"Einfügen"}
            ]"#,
        )
        .expect("entries parse");
        assert_eq!(entries.len(), 6);
        assert!(matches!(&entries[1], PopupMenuEntry::Item { checked: Some(true), enabled: false, .. }));
        assert!(matches!(&entries[3], PopupMenuEntry::Submenu { items, .. } if items.len() == 1));
        assert!(matches!(&entries[5], PopupMenuEntry::Predefined { text: Some(text), .. } if text == "Einfügen"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lists_applications_that_can_open_a_text_file() {
        let file = std::env::temp_dir().join(format!("pi-open-with-{}.txt", std::process::id()));
        std::fs::write(&file, "hello").unwrap();
        let apps = super::list_apps_for_file_macos(&file);
        let _ = std::fs::remove_file(&file);

        let apps = apps.unwrap();
        let apps = apps.as_array().expect("an array of apps");
        assert!(!apps.is_empty(), "TextEdit at least can open a .txt file");
        for app in apps {
            let path = app["path"].as_str().expect("path");
            assert!(path.ends_with(".app"), "{path}");
            assert!(!app["name"].as_str().expect("name").is_empty());
            assert!(app["isDefault"].is_boolean());
        }
        let defaults = apps.iter().filter(|app| app["isDefault"] == true).count();
        assert!(defaults <= 1);
        if defaults == 1 {
            assert_eq!(apps[0]["isDefault"], true, "default app is listed first");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn open_with_refuses_relative_missing_and_non_bundle_targets() {
        let file = std::env::temp_dir().join(format!("pi-open-with-guard-{}.txt", std::process::id()));
        std::fs::write(&file, "hello").unwrap();
        let bundle = Path::new("/System/Applications/TextEdit.app");

        assert!(super::open_path_with_app_macos(Path::new("relative.txt"), bundle).is_err());
        assert!(super::open_path_with_app_macos(&file.with_extension("missing"), bundle).is_err());
        // A regular file, or a folder that is not an .app bundle, is never launched.
        assert!(super::open_path_with_app_macos(&file, &file).is_err());
        assert!(super::open_path_with_app_macos(&file, Path::new("/usr/bin")).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(windows)]
    #[test]
    fn simplifies_verbatim_windows_path_before_launching_node() {
        let path = Path::new(
            r"\\?\C:\Users\毕良霞\AppData\Local\Pi Agent\resources\server\desktop-server.cjs",
        );

        assert_eq!(
            child_process_compatible_path(path),
            PathBuf::from(
                r"C:\Users\毕良霞\AppData\Local\Pi Agent\resources\server\desktop-server.cjs"
            )
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn leaves_non_windows_path_unchanged() {
        let path = Path::new("/Applications/Pi Agent.app/Contents/Resources/server");
        assert_eq!(child_process_compatible_path(path), PathBuf::from(path));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_tray_menu_items_publish_visible_labels() {
        for label in [LINUX_TRAY_SHOW_LABEL, LINUX_TRAY_QUIT_LABEL] {
            let item = visible_linux_tray_item(label, |_: &mut LinuxTray| {});
            let ksni::MenuItem::Standard(item) = item else {
                panic!("Linux tray command must be a standard menu item");
            };

            assert_eq!(item.label, label);
            assert!(item.enabled);
            assert!(item.visible);
        }
    }

    #[test]
    fn packaged_server_handshake_requires_the_expected_instance_header() {
        let expected = "instance-123";
        let matching = b"HTTP/1.1 204 No Content\r\nx-pi-desktop-instance: instance-123\r\n\r\n";
        let wrong = b"HTTP/1.1 204 No Content\r\nx-pi-desktop-instance: other\r\n\r\n";
        let body_spoof = b"HTTP/1.1 204 No Content\r\nContent-Type: text/plain\r\n\r\ninstance-123";

        assert!(response_has_instance_id(matching, expected));
        assert!(!response_has_instance_id(wrong, expected));
        assert!(!response_has_instance_id(body_spoof, expected));
    }
}

#[cfg(not(feature = "custom-protocol"))]
fn start_development_server(
    _app: &tauri::AppHandle,
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    Ok((DEV_SERVER_URL.parse()?, DesktopServer::empty()))
}

/// Single-instance guard (Linux only). Launching the app binary again starts a
/// brand-new process instead of focusing the running one, which left multiple
/// server/window copies in the background. We claim a PID lock file; a later
/// launch asks the live instance to raise its window via a request file and
/// exits without starting another server. macOS already gets that behavior
/// from the OS (LaunchServices + the `Reopen` handler below), and Windows has
/// its own semantics, so this mechanism is intentionally Linux-scoped and
/// keeps its `/proc`-based liveness probe off the other platforms.
///
/// Focus signalling deliberately uses a polled request file instead of a
/// signal: JavaScriptCore owns SIGUSR1 on Linux (its GC suspension signal),
/// and raising it from a second launch would land in JSC's GC handler and
/// corrupt the process (SEGV).
#[cfg(target_os = "linux")]
const FOCUS_REQUEST_FILE: &str = "focus.request";

#[cfg(target_os = "linux")]
fn instance_lock_path() -> Option<PathBuf> {
    let base = env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("XDG_CONFIG_HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".config"))
        });
    base.map(|value| value.join("com.abcwyc.pi-agent").join("pi-agent.lock"))
}

#[cfg(target_os = "linux")]
fn process_is_our_app(pid: i32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .map(|content| {
            let lowered = content.to_lowercase();
            lowered.contains("pi-agent") || lowered.contains("pi agent")
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn read_lock_pid(path: &Path) -> Option<i32> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| raw.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
}

/// Ask a live instance recorded in the lock file to raise its window, if any.
#[cfg(target_os = "linux")]
fn focus_existing_instance(path: &Path) -> bool {
    if let Some(pid) = read_lock_pid(path) {
        if process_is_our_app(pid) && unsafe { libc::kill(pid, 0) } == 0 {
            // The primary's focus monitor polls this file (see
            // `spawn_focus_monitor`); the secondary never signals it.
            if let Some(request) = focus_request_path() {
                let _ = fs::write(&request, b"1");
            }
            return true;
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn focus_request_path() -> Option<PathBuf> {
    instance_lock_path().map(|lock| match lock.parent() {
        Some(parent) => parent.join(FOCUS_REQUEST_FILE),
        None => lock,
    })
}

/// Returns true when this process should become the primary instance. When
/// another live instance already owns the lock, this asks it to show its
/// window and returns false so the caller can exit.
#[cfg(target_os = "linux")]
fn ensure_single_instance() -> bool {
    let Some(path) = instance_lock_path() else {
        return true;
    };

    // An existing live instance owns the lock: focus it and stay secondary.
    if focus_existing_instance(&path) {
        return false;
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // The lock file can outlive its owner: a crashed, killed, or panicked
    // instance never removes it, and a launch interrupted between open() and
    // write() leaves an empty file. Reclaim it only when the recorded PID is
    // no longer a live copy of this app, so a genuinely running instance is
    // never displaced by a mistaken cleanup.
    if path.exists() {
        let owner_live = read_lock_pid(&path)
            .map(|pid| process_is_our_app(pid) && unsafe { libc::kill(pid, 0) } == 0)
            .unwrap_or(false);
        if !owner_live {
            let _ = fs::remove_file(&path);
        }
    }

    // Claim the lock atomically so two near-simultaneous launches cannot both
    // become primary. `create_new` (O_CREAT | O_EXCL) fails if the file exists.
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let _ = file.write_all(std::process::id().to_string().as_bytes());
            let _ = file.sync_all();
            // Clear a focus request left behind by a crashed previous primary.
            if let Some(request) = focus_request_path() {
                let _ = fs::remove_file(request);
            }
            true
        }
        Err(_) => {
            // Lost the race: defer to the instance that won the lock.
            focus_existing_instance(&path);
            false
        }
    }
}

#[cfg(target_os = "linux")]
fn remove_instance_lock() {
    if let Some(path) = instance_lock_path() {
        // Only remove a lock this process owns; never delete a lock that a
        // racing launch reclaimed after our shutdown began.
        if read_lock_pid(&path) == Some(std::process::id() as i32) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_focus_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        if let Some(request) = focus_request_path() {
            if request.exists() {
                // Consume the request before dispatching so a repeat request
                // while the window cannot be raised still triggers a retry.
                let _ = fs::remove_file(&request);
                let value = app.clone();
                let _ = app.run_on_main_thread(move || show_main_window(&value));
            }
        }
        thread::sleep(Duration::from_millis(120));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Become the single instance (Linux). If another live instance owns the
    // lock, focus it and exit without starting a second server/window.
    #[cfg(target_os = "linux")]
    {
        if !ensure_single_instance() {
            std::process::exit(0);
        }
    }

    let desktop_api_token = load_or_generate_desktop_api_token()
        .expect("failed to create desktop API authorization token");
    let desktop_instance_id =
        generate_random_hex().expect("failed to create desktop server instance id");
    #[cfg(feature = "custom-protocol")]
    let server_api_token = desktop_api_token.clone();
    #[cfg(feature = "custom-protocol")]
    let server_instance_id = desktop_instance_id.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .on_menu_event(|app, event| {
            // A popup menu's click: hand it to the command waiting on it.
            if event.id().as_ref().starts_with(POPUP_ID_PREFIX) {
                if let Some(state) = app.try_state::<PopupMenuSelection>() {
                    if let Ok(slot) = state.0.lock() {
                        if let Some(sender) = slot.as_ref() {
                            let _ = sender.send(event.id().as_ref().to_string());
                        }
                    }
                }
                return;
            }
            let action = match event.id().as_ref() {
                "new-session" => Some("new-session"),
                "settings-general" => Some("settings-general"),
                "settings-models" => Some("settings-models"),
                _ => None,
            };
            let Some(action) = action else { return };
            if let Err(error) = app.emit("pi-agent-menu-action", action) {
                eprintln!("Pi Agent menu action failed: {error}");
            }
        })
        .manage(CloseQuits(Mutex::new(false)))
        .manage(PopupMenuSelection::default())
        .manage(DesktopApiToken(desktop_api_token))
        .invoke_handler(tauri::generate_handler![
            get_desktop_api_token,
            open_external_url,
            open_path,
            reveal_item_in_dir,
            list_apps_for_file,
            open_path_with,
            show_popup_menu,
            set_close_quits,
            quit_app,
            show_main_window_cmd,
            set_ui_theme
        ])
        .setup(move |app| {
            // The updater public key is embedded at compile time by the release
            // workflow. Local development builds intentionally omit it, which
            // keeps unsigned builds from accepting production updates.
            if let Some(public_key) = option_env!("PI_AGENT_DESKTOP_UPDATER_PUBLIC_KEY")
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                app.handle().plugin(
                    tauri_plugin_updater::Builder::new()
                        .pubkey(public_key)
                        .build(),
                )?;
            }

            #[cfg(feature = "custom-protocol")]
            let (url, server) =
                start_packaged_server(app.handle(), &server_api_token, &server_instance_id)?;
            #[cfg(not(feature = "custom-protocol"))]
            let (url, server) = start_development_server(app.handle())?;

            app.manage(server);
            // Clear stale webview caches when the app version changed since the
            // last successful launch (fixes WebKitGTK loading stale hashed
            // Next.js assets after an upgrade).
            reconcile_webview_cache_for_version(app.handle());
            build_window(app.handle(), url)?;
            // Record the current version only after the window built cleanly,
            // so a startup crash keeps the cache clear flagged on relaunch.
            write_last_version(app.handle());

            #[cfg(target_os = "linux")]
            build_linux_tray(app)?;
            // Keep the standard macOS menu even while the web UI draws its own
            // top bar; only this path owns Edit commands and Cmd+,/Cmd+M.
            #[cfg(target_os = "macos")]
            build_macos_app_menu(app.handle())?;
            #[cfg(not(target_os = "linux"))]
            build_platform_tray(app)?;

            #[cfg(target_os = "linux")]
            spawn_focus_monitor(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let quit = window
                        .app_handle()
                        .try_state::<CloseQuits>()
                        .and_then(|state| state.0.lock().ok().map(|guard| *guard))
                        .unwrap_or(false);
                    if quit {
                        quit_application(window.app_handle());
                    } else {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pi Agent desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            #[cfg(target_os = "linux")]
            remove_instance_lock();
            if let Some(server) = app_handle.try_state::<DesktopServer>() {
                server.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } if !has_visible_windows => {
            if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
