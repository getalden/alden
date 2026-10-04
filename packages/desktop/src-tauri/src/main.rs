//! Alden's desktop app: a window and a menu-bar item around `alden ui`.
//!
//! It runs the bundled `alden` binary as `alden ui --json` in the folder you chose (your home folder until you pick a
//! repo clone: your uncommitted changes come from there, and right after you choose, the window shows that repo's PRs;
//! PR callers come from any clone Alden knows), shows its UI in the window, and polls the local API for the
//! menu bar: how many PRs wait on you, the top three, and a notification when someone has waited three days. While
//! you're away from the Mac, it asks the server to brief the top PRs ahead of time and says when one is ready. Closing
//! the window keeps Alden in the menu bar; Quit stops it and the server with it (the server also exits on its own when
//! this app's end of its stdin closes, so a crash can't leave it running).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashSet, path::PathBuf, sync::Mutex, time::Duration};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, Url, WindowEvent, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Someone who has waited this long gets a nudge, once per PR per run.
const WAITED_TOO_LONG_HOURS: f64 = 72.0;
/// How often the menu bar refreshes. The server caches GitHub for a minute, so this is cheap.
const POLL_EVERY: Duration = Duration::from_secs(300);
/// How often to check whether you're away, and how long without a key press or mouse move counts as away.
const IDLE_CHECK_EVERY: Duration = Duration::from_secs(60);
const AWAY_AFTER_SECS: f64 = 180.0;
const TRAY: &str = "main";

#[derive(Default)]
struct AppState {
    /// "http://127.0.0.1:PORT" once the server is up.
    base: Mutex<Option<String>>,
    token: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
    notified: Mutex<HashSet<String>>,
    polling: Mutex<bool>,
    /// A background briefing is running; don't start another.
    preparing: Mutex<bool>,
    /// You just chose a folder: the window's next link says so, and the UI shows that repo's PRs.
    chose_folder: Mutex<bool>,
}

#[derive(Deserialize)]
struct PrepareResult {
    prepared: Option<PreparedPr>,
}

#[derive(Deserialize)]
struct PreparedPr {
    pr: String,
    title: String,
    places: u32,
}

#[derive(Deserialize)]
struct ReadyPr {
    pr: String,
}

#[derive(Deserialize)]
struct Ready {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Queue {
    needs_you: Vec<Row>,
    fast_track: Vec<Row>,
    /// e.g. an org that hides its PRs from this sign-in; the window shows them in full.
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    pr: Pr,
    waiting_hours: f64,
    waiting_on_author: bool,
}

#[derive(Deserialize)]
struct Pr {
    repo: String,
    number: u64,
    title: String,
    author: Option<String>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show(app, None);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id(TRAY)
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Alden")
                .menu(&menu(&handle, "Starting Alden…", "", &[])?)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
                .build(app)?;

            #[cfg(target_os = "macos")]
            let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
            #[cfg(not(target_os = "macos"))]
            let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;
            // Another app may own the shortcut; the menu still opens the window.
            let _ = app.global_shortcut().register(Shortcut::new(Some(modifiers), Code::KeyA));

            start_server(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Alden in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Alden couldn't start")
        .run(|app, event| match event {
            RunEvent::Exit => stop_server(app),
            // Clicking Alden in the Dock after closing its window brings the window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show(app, None),
            _ => {}
        });
}

/// The folder `alden ui` runs in: the one you picked last, or your home folder.
fn folder(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("folder.txt")).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_dir())
        .or_else(|| app.path().home_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn status(app: &AppHandle, text: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let text = serde_json::to_string(text).unwrap_or_default();
        let _ = window.eval(&format!(
            "(() => {{ const el = document.getElementById('status'); if (el) el.textContent = {text}; }})()"
        ));
    }
}

/// An app opened from the Finder gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so `alden` wouldn't find the GitHub
/// CLI (for its sign-in) or a Homebrew git. Add the places Homebrew installs them.
#[cfg(unix)]
fn sidecar_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty())
        .map(String::from)
        .collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        if !parts.iter().any(|part| part == extra) {
            parts.push(extra.to_string());
        }
    }
    parts.join(":")
}

fn start_server(app: &AppHandle) {
    let dir = folder(app);
    let command = match app.shell().sidecar("alden") {
        Ok(command) => command,
        Err(error) => return status(app, &format!("Alden's binary is missing from the app: {error}")),
    };
    let command = command.args(["ui", "--json"]).current_dir(&dir).env("ALDEN_NO_UPDATE_CHECK", "1");
    #[cfg(unix)]
    let command = command.env("PATH", sidecar_path());
    let spawned = command.spawn();
    let (mut events, child) = match spawned {
        Ok(pair) => pair,
        Err(error) => return status(app, &format!("Couldn't start Alden: {error}")),
    };
    *app.state::<AppState>().child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stderr = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(ready) = serde_json::from_slice::<Ready>(line.trim_ascii()) {
                        on_ready(&app, &ready.url);
                    }
                }
                CommandEvent::Stderr(line) => {
                    stderr.push_str(&String::from_utf8_lossy(&line));
                    stderr.truncate(2_000);
                }
                CommandEvent::Terminated(end) => {
                    let detail = stderr.lines().last().unwrap_or("").to_string();
                    status(&app, &format!("Alden stopped (code {:?}). {detail}", end.code));
                    *app.state::<AppState>().base.lock().unwrap() = None;
                    break;
                }
                _ => {}
            }
        }
    });
}

fn stop_server(app: &AppHandle) {
    if let Some(child) = app.state::<AppState>().child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn on_ready(app: &AppHandle, url: &str) {
    let Ok(parsed) = Url::parse(url) else { return };
    let base = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("127.0.0.1"))
        + &parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    let token = parsed
        .fragment()
        .and_then(|f| f.split('&').find_map(|kv| kv.strip_prefix("t=")))
        .map(str::to_string);
    let state = app.state::<AppState>();
    *state.base.lock().unwrap() = Some(base);
    *state.token.lock().unwrap() = token;
    let chose = std::mem::take(&mut *state.chose_folder.lock().unwrap());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(with_chosen_folder(parsed, chose));
    }
    let first = {
        let mut polling = state.polling.lock().unwrap();
        !std::mem::replace(&mut *polling, true)
    };
    if first {
        let app = app.clone();
        let idle_app = app.clone();
        let offer_app = app.clone();
        tauri::async_runtime::spawn(async move { first_launch_cli(&offer_app).await });
        tauri::async_runtime::spawn(async move {
            loop {
                poll(&app).await;
                tokio::time::sleep(POLL_EVERY).await;
            }
        });
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_CHECK_EVERY).await;
                if idle_seconds().is_some_and(|secs| secs >= AWAY_AFTER_SECS) {
                    prepare_next(&idle_app).await;
                }
            }
        });
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { poll(&app).await });
    }
}

/// Reads the queue from the local server and updates the menu bar, nudging about long waits.
async fn poll(app: &AppHandle) {
    let (base, token) = {
        let state = app.state::<AppState>();
        let base = state.base.lock().unwrap().clone();
        let token = state.token.lock().unwrap().clone();
        (base, token)
    };
    let (Some(base), Some(token)) = (base, token) else { return };
    let response = reqwest::Client::new()
        .get(format!("{base}/api/queue"))
        .header("X-Alden-Token", &token)
        .timeout(Duration::from_secs(60))
        .send()
        .await;
    let queue = match response {
        Ok(res) if res.status().is_success() => res.json::<Queue>().await.ok(),
        Ok(res) if res.status().as_u16() == 409 => {
            return set_tray(app, "Sign in to GitHub", "Open Alden to sign in", &[], None)
        }
        _ => None,
    };
    let Some(queue) = queue else {
        return set_tray(app, "Couldn't read your queue", "Alden will try again soon", &[], None);
    };

    let total = queue.needs_you.len() + queue.fast_track.len();
    let header = match total {
        0 => "Nothing is waiting on you".to_string(),
        1 => "1 waiting on you".to_string(),
        n => format!("{n} waiting on you"),
    };
    let hidden = queue.warnings.iter().any(|w| w.contains("missing"));
    let sub = match (total, hidden) {
        (0, false) => String::new(),
        (0, true) => "Some organizations' PRs are hidden: open Alden".to_string(),
        (_, false) => format!("{} need you · {} fast", queue.needs_you.len(), queue.fast_track.len()),
        (_, true) => format!(
            "{} need you · {} fast · some hidden",
            queue.needs_you.len(),
            queue.fast_track.len()
        ),
    };
    let ready: HashSet<String> = api_get::<Vec<ReadyPr>>(&base, &token, "/api/prepared")
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.pr.to_lowercase())
        .collect();
    let rows: Vec<(String, String)> = queue
        .needs_you
        .iter()
        .take(3)
        .enumerate()
        .map(|(i, row)| {
            let key = format!("{}#{}", row.pr.repo, row.pr.number).to_lowercase();
            let mark = if ready.contains(&key) { "  ✓ ready" } else { "" };
            (
                format!("pr:{}/pull/{}", row.pr.repo, row.pr.number),
                format!(
                    "{:02}  {}  ·  {} #{} · {}{mark}",
                    i + 1,
                    clip(&row.pr.title, 46),
                    row.pr.repo,
                    row.pr.number,
                    wait(row.waiting_hours)
                ),
            )
        })
        .collect();
    set_tray(app, &header, &sub, &rows, Some(total));

    for row in queue.needs_you.iter().filter(|r| r.waiting_hours >= WAITED_TOO_LONG_HOURS && !r.waiting_on_author) {
        let key = format!("{}#{}", row.pr.repo, row.pr.number);
        if !app.state::<AppState>().notified.lock().unwrap().insert(key) {
            continue;
        }
        let who = row.pr.author.as_deref().map(|a| format!("@{a}")).unwrap_or_else(|| "Someone".into());
        let _ = app
            .notification()
            .builder()
            .title(format!("{who} has waited {}", wait(row.waiting_hours)))
            .body(format!("{} · {} #{}", row.pr.title, row.pr.repo, row.pr.number))
            .show();
    }
}

/// A GET on the local API, parsed; None on any failure (the menu bar just shows less).
async fn api_get<T: serde::de::DeserializeOwned>(base: &str, token: &str, path: &str) -> Option<T> {
    let res = reqwest::Client::new()
        .get(format!("{base}{path}"))
        .header("X-Alden-Token", token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<T>().await.ok()
}

/// While you're away: asks the server to brief the next of your top PRs (it decides which, and whether background
/// briefings are on), then says so when one is ready.
async fn prepare_next(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut preparing = state.preparing.lock().unwrap();
        if *preparing {
            return;
        }
        *preparing = true;
    }
    let (base, token) = (state.base.lock().unwrap().clone(), state.token.lock().unwrap().clone());
    let result = match (base, token) {
        (Some(base), Some(token)) => reqwest::Client::new()
            .post(format!("{base}/api/prepare"))
            .header("X-Alden-Token", token)
            // A briefing with the model on a large PR can take a few minutes.
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .ok()
            .filter(|res| res.status().is_success()),
        _ => None,
    };
    let prepared = match result {
        Some(res) => res.json::<PrepareResult>().await.ok().and_then(|r| r.prepared),
        None => None,
    };
    *state.preparing.lock().unwrap() = false;
    let Some(pr) = prepared else { return };

    let places = match pr.places {
        0 => "Nothing needs a closer look.".to_string(),
        1 => "1 place needs your eyes.".to_string(),
        n => format!("{n} places need your eyes."),
    };
    let _ = app
        .notification()
        .builder()
        .title(format!("Briefing ready: {}", pr.pr))
        .body(format!("{} · {places}", clip(&pr.title, 80)))
        .show();
    poll(app).await;
}

/// Seconds since the last key press, click or mouse move. Only macOS for now; elsewhere nothing runs in the background.
#[cfg(target_os = "macos")]
fn idle_seconds() -> Option<f64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType.
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    secs.is_finite().then_some(secs)
}

#[cfg(not(target_os = "macos"))]
fn idle_seconds() -> Option<f64> {
    None
}

fn set_tray(app: &AppHandle, header: &str, sub: &str, rows: &[(String, String)], count: Option<usize>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    if let Ok(menu) = menu(app, header, sub, rows) {
        let _ = tray.set_menu(Some(menu));
    }
    // The count beside the icon (macOS shows a tray title; elsewhere the tooltip carries it).
    let _ = tray.set_title(count.filter(|n| *n > 0).map(|n| n.to_string()));
    let _ = tray.set_tooltip(Some(format!("Alden · {header}")));
}

fn menu(app: &AppHandle, header: &str, sub: &str, rows: &[(String, String)]) -> tauri::Result<Menu<Wry>> {
    let mut builder = MenuBuilder::new(app).item(&MenuItemBuilder::with_id("header", header).enabled(false).build(app)?);
    if !sub.is_empty() {
        builder = builder.item(&MenuItemBuilder::with_id("sub", sub).enabled(false).build(app)?);
    }
    builder = builder.separator();
    for (id, label) in rows {
        builder = builder.item(&MenuItemBuilder::with_id(id.as_str(), label).build(app)?);
    }
    if !rows.is_empty() {
        builder = builder.separator();
    }
    builder
        .item(&MenuItemBuilder::with_id("open", "Open Alden").accelerator("CmdOrCtrl+Shift+A").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh now").build(app)?)
        .item(&MenuItemBuilder::with_id("folder", "Choose repo folder…").build(app)?)
        .item(&MenuItemBuilder::with_id("cli", "Install command line tool…").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Alden"))?)
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show(app, None),
        "refresh" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { poll(&app).await });
        }
        "folder" => choose_folder(app),
        "cli" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { install_cli(&app).await });
        }
        other => {
            if let Some(path) = other.strip_prefix("pr:") {
                // "owner/repo/pull/12" → the UI's own route for that PR.
                if let Some((repo, number)) = path.split_once("/pull/") {
                    show(app, Some(format!("/pr/{repo}/{number}")));
                }
            }
        }
    }
}

/// Shows the window, optionally at one of the UI's routes (it's a single-page app, so this pushes history).
fn show(app: &AppHandle, route: Option<String>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(route) = route {
        let route = serde_json::to_string(&route).unwrap_or_default();
        let _ = window.eval(&format!(
            "history.pushState(null, '', {route}); dispatchEvent(new PopStateEvent('popstate'));"
        ));
    }
}

/// After you chose a folder, the link tells the UI (`folder=chosen` in the fragment, beside the session key), so it
/// shows that repo's PRs and says where callers now come from.
fn with_chosen_folder(mut url: Url, chose: bool) -> Url {
    if chose {
        let fragment = url.fragment().map(|f| format!("{f}&folder=chosen")).unwrap_or_else(|| "folder=chosen".into());
        url.set_fragment(Some(&fragment));
    }
    url
}

/// "/Users/sam/src/x" → "~/src/x", for messages.
fn tilde(path: &std::path::Path, home: Option<PathBuf>) -> String {
    match home.and_then(|home| path.strip_prefix(home).ok().map(|rest| rest.to_path_buf())) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

fn choose_folder(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(picked) = app.dialog().file().set_title("Run Alden in which clone?").blocking_pick_folder() else {
            return;
        };
        let Ok(path) = picked.into_path() else { return };
        if let Ok(dir) = app.path().app_config_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("folder.txt"), path.to_string_lossy().as_bytes());
        }
        stop_server(&app);
        *app.state::<AppState>().chose_folder.lock().unwrap() = true;
        status(&app, &format!("Starting Alden in {}…", tilde(&path, app.path().home_dir().ok())));
        start_server(&app);
    });
}

#[derive(Deserialize)]
struct CliStatus {
    state: String,
}

#[derive(Deserialize)]
struct CliInstall {
    state: String,
    path: Option<String>,
    message: Option<String>,
}

/// Installs the `alden` command (the server links the app's own copy into /usr/local/bin after macOS asks for an
/// administrator's password), and says how it went.
async fn install_cli(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (base, token) = (state.base.lock().unwrap().clone(), state.token.lock().unwrap().clone());
    let (Some(base), Some(token)) = (base, token) else {
        return say(app, "Alden is still starting. Try again in a moment.".into());
    };
    let result = reqwest::Client::new()
        .post(format!("{base}/api/cli/install"))
        .header("X-Alden-Token", token)
        // The password prompt waits on the user.
        .timeout(Duration::from_secs(300))
        .send()
        .await;
    let install = match result {
        Ok(res) if res.status().is_success() => res.json::<CliInstall>().await.ok(),
        _ => None,
    };
    let text = match install {
        Some(i) if i.state == "installed" => format!(
            "The alden command is installed at {}, so you can use Alden in a terminal and from Claude Code and other \
             AI coding tools. Open a new terminal window and run `alden --version`. It updates with the app.",
            i.path.unwrap_or_default()
        ),
        Some(i) if i.state == "exists" => format!(
            "There's already an alden command at {}. The app and that command share your sign-in, settings and memory.",
            i.path.unwrap_or_default()
        ),
        Some(i) if i.state == "cancelled" => return,
        Some(i) => format!("Couldn't install the command: {}", i.message.unwrap_or_default()),
        None => "Couldn't install the command.".into(),
    };
    say(app, text);
}

fn say(app: &AppHandle, text: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        app.dialog().message(text).title("Alden").blocking_show();
    });
}

/// On the first launch, installs the `alden` command, so the app comes with it as Docker Desktop does: nothing to do
/// when the Homebrew cask already linked it, a link when /usr/local/bin is writable, otherwise one password prompt
/// from macOS. Cancelling is fine: Settings and the menu offer it again, and it isn't asked again on its own.
async fn first_launch_cli(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let done = dir.join("cli-offered");
    if done.exists() {
        return;
    }
    let (base, token) = {
        let state = app.state::<AppState>();
        let base = state.base.lock().unwrap().clone();
        let token = state.token.lock().unwrap().clone();
        (base, token)
    };
    let (Some(base), Some(token)) = (base, token) else { return };
    let Some(status) = api_get::<CliStatus>(&base, &token, "/api/cli").await else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&done, b"");
    if status.state == "missing" {
        install_cli(app).await;
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
    }
}

fn wait(hours: f64) -> String {
    if hours < 1.0 {
        "<1h".into()
    } else if hours < 48.0 {
        format!("{}h", hours.floor())
    } else {
        format!("{} days", (hours / 24.0).floor())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn reads_idle_time_on_macos() {
        let secs = idle_seconds().expect("CoreGraphics answers");
        assert!(secs >= 0.0);
    }

    #[test]
    fn marks_the_link_after_you_chose_a_folder() {
        let url = Url::parse("http://127.0.0.1:4100/#t=abc").unwrap();
        assert_eq!(with_chosen_folder(url.clone(), false).as_str(), "http://127.0.0.1:4100/#t=abc");
        assert_eq!(with_chosen_folder(url, true).as_str(), "http://127.0.0.1:4100/#t=abc&folder=chosen");
    }

    #[test]
    fn shortens_the_home_folder() {
        let home = Some(PathBuf::from("/Users/sam"));
        assert_eq!(tilde(std::path::Path::new("/Users/sam/src/x"), home.clone()), "~/src/x");
        assert_eq!(tilde(std::path::Path::new("/Users/sam"), home.clone()), "~");
        assert_eq!(tilde(std::path::Path::new("/opt/x"), home), "/opt/x");
    }

    #[test]
    fn reads_what_the_server_prepared() {
        let result: PrepareResult =
            serde_json::from_str(r#"{"prepared":{"pr":"a/b#1","title":"T","places":2,"model":false,"at":"x"}}"#).unwrap();
        let pr = result.prepared.unwrap();
        assert_eq!((pr.pr.as_str(), pr.places), ("a/b#1", 2));
        let none: PrepareResult = serde_json::from_str(r#"{"prepared":null,"reason":"off"}"#).unwrap();
        assert!(none.prepared.is_none());
    }
}
