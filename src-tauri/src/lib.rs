use std::{
    env,
    fs::{self, OpenOptions},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{
    webview::NewWindowResponse, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const WINDOW_LABEL: &str = "main";
#[cfg(not(feature = "custom-protocol"))]
const DEV_SERVER_URL: &str = "http://127.0.0.1:30141";
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(30);

struct DesktopServer {
    child: Mutex<Option<Child>>,
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
        let Some(mut child) = guard.take() else {
            return;
        };

        #[cfg(unix)]
        unsafe {
            // The Node server owns its process group, so this also stops any
            // agent/tool subprocesses that are active when the App quits.
            libc::kill(-(child.id() as i32), libc::SIGTERM);
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }

        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
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
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

fn same_origin(candidate: &Url, app_url: &Url) -> bool {
    candidate.scheme() == app_url.scheme()
        && candidate.host_str() == app_url.host_str()
        && candidate.port_or_known_default() == app_url.port_or_known_default()
}

fn build_window(app: &tauri::AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let navigation_origin = app_url.clone();

    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
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
        })
        .build()
}

#[cfg(feature = "custom-protocol")]
fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
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

#[cfg(feature = "custom-protocol")]
fn choose_port() -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(feature = "custom-protocol")]
fn wait_for_server(child: &mut Child, address: SocketAddr, log_path: &Path) -> io::Result<()> {
    let deadline = Instant::now() + SERVER_START_TIMEOUT;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }

        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "Pi Agent server exited early with {status}; see {}",
                log_path.display()
            )));
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
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    let node_path = app
        .path()
        .resource_dir()?
        .join("resources/Pi Agent Server.app/Contents/MacOS/node");
    if !node_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Bundled Node runtime is missing: {}", node_path.display()),
        )
        .into());
    }

    let server_dir = app.path().resource_dir()?.join("resources/server");
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

    let port = choose_port()?;
    let mut command = Command::new(&node_path);
    command
        .arg(&server_script)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("PI_WEB_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if let Some(path) = login_shell_path() {
        command.env("PATH", path);
    }

    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn()?;

    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    if let Err(error) = wait_for_server(&mut child, address, &log_path) {
        let server = DesktopServer::running(child);
        server.stop();
        return Err(error.into());
    }

    let url = format!("http://127.0.0.1:{port}").parse()?;
    Ok((url, DesktopServer::running(child)))
}

#[cfg(not(feature = "custom-protocol"))]
fn start_development_server(
    _app: &tauri::AppHandle,
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    Ok((DEV_SERVER_URL.parse()?, DesktopServer::empty()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
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
            let (url, server) = start_packaged_server(app.handle())?;
            #[cfg(not(feature = "custom-protocol"))]
            let (url, server) = start_development_server(app.handle())?;

            app.manage(server);
            build_window(app.handle(), url)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pi Agent desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            if let Some(server) = app_handle.try_state::<DesktopServer>() {
                server.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }
        _ => {}
    });
}
