#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod profile;
mod canvas_window;
mod native_ui;
mod browser_workspace;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindowBuilder, WebviewUrl, WindowEvent,
};
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, Arc, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
};

const BOUNDS: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);
#[derive(Default)]
struct RoundedBounds(Mutex<std::collections::HashMap<String, (u32, u32)>>);

fn round_window(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let Ok(size) = window.outer_size() else { return; };
        let state = window.state::<RoundedBounds>();
        if let Ok(mut sizes) = state.0.lock() {
            if sizes.get(window.label()) == Some(&(size.width, size.height)) { return; }
            sizes.insert(window.label().to_owned(), (size.width, size.height));
        }
        let Ok(hwnd) = window.hwnd() else { return; };
        let radius = (14.0 * window.scale_factor().unwrap_or(1.0)) as i32;
        #[link(name = "gdi32")]
        extern "system" { fn CreateRoundRectRgn(left: i32, top: i32, right: i32, bottom: i32, width: i32, height: i32) -> isize; fn DeleteObject(object: isize) -> i32; }
        #[link(name = "user32")]
        extern "system" { fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32; }
        unsafe {
            let region = CreateRoundRectRgn(0, 0, size.width as i32 + 1, size.height as i32 + 1, radius * 2, radius * 2);
            if region != 0 && SetWindowRgn(hwnd.0 as isize, region, 1) == 0 { DeleteObject(region); }
        }
    }
}

#[tauri::command]
fn drag_window(window: tauri::WebviewWindow) -> Result<(), String> { window.start_dragging().map_err(|e| e.to_string()) }

#[tauri::command]
fn resize_window(window: tauri::WebviewWindow, edge: String) -> Result<(), String> {
    use tauri_runtime::ResizeDirection::*;
    let direction = match edge.as_str() { "North" => North, "South" => South, "East" => East, "West" => West, "NorthEast" => NorthEast, "NorthWest" => NorthWest, "SouthEast" => SouthEast, "SouthWest" => SouthWest, _ => return Err("无效的缩放方向".into()) };
    let webview: &tauri::Webview = window.as_ref();
    webview.window().start_resize_dragging(direction).map_err(|e| e.to_string())
}

#[derive(Default)]
struct BoundsAutosave {
    revision: Arc<AtomicU64>,
    pending: Arc<AtomicBool>,
}

// One short-lived worker per burst, not per resize event. Flush on the UI thread
// after geometry settles so the plugin's native window reads cannot deadlock it.
fn schedule_bounds_save(app: &tauri::AppHandle) {
    let state = app.state::<BoundsAutosave>();
    state.revision.fetch_add(1, Ordering::SeqCst);
    if state.pending.swap(true, Ordering::SeqCst) { return; }
    let revision = state.revision.clone();
    let pending = state.pending.clone();
    let app = app.clone();
    thread::spawn(move || loop {
        let observed = revision.load(Ordering::SeqCst);
        thread::sleep(std::time::Duration::from_millis(500));
        if revision.load(Ordering::SeqCst) != observed { continue; }
        pending.store(false, Ordering::SeqCst);
        if revision.load(Ordering::SeqCst) != observed {
            if pending.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() { continue; }
            break;
        }
        let current = revision.clone();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if current.load(Ordering::SeqCst) == observed {
                if let Err(error) = handle.save_window_state(BOUNDS) {
                    startup_log(&format!("Window bounds autosave failed: {error}"));
                }
            }
        });
        break;
    });
}

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AgentState(Mutex<Option<AgentProcess>>);
#[derive(Default)]
struct ShortcutStateStore(Mutex<String>);
#[derive(Default)]
struct ReadyWindows(Mutex<HashSet<String>>);

fn native_window_is_ready(thread_id: u32, owner_pid: u32, property_pid: u32) -> bool {
    thread_id != 0 && owner_pid != 0 && property_pid == owner_pid
}

fn ui_window_is_ready(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<ReadyWindows>().0.lock().map(|ready| ready.contains(label)).unwrap_or(false)
}

#[cfg(windows)]
fn instance_lock_name() -> String {
    if let Some(directory) = std::env::var_os("SUMMON_TEST_DATA_DIR") {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        directory.hash(&mut hasher);
        format!("Local\\dev.rynorca.summon.test.{}", hasher.finish())
    } else {
        "Local\\dev.rynorca.summon.instance".to_owned()
    }
}

#[cfg(windows)]
fn ready_property_name(lock_name: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(&format!("Reed.MainWindowReady.{lock_name}"))
        .encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn mark_native_main_window_ready(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[link(name = "user32")]
    extern "system" {
        fn SetPropW(window: isize, name: *const u16, data: *mut std::ffi::c_void) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
    }
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let property = ready_property_name(&instance_lock_name());
    let pid = unsafe { GetCurrentProcessId() };
    if unsafe { SetPropW(hwnd.0 as isize, property.as_ptr(), pid as usize as *mut std::ffi::c_void) } == 0 {
        return Err(format!("Cannot mark main window UI-ready: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_directory(app)?.join("user-config.json"))
}

fn data_directory(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    profile::directory().map_err(|error| error.to_string())
}

fn read_preferences(app: &tauri::AppHandle) -> serde_json::Value {
    let saved=preferences_path(app).ok().and_then(|p|std::fs::read_to_string(p).ok()).and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok());
    saved.and_then(|v|v.get("desktop").cloned()).or_else(||data_directory(app).ok().and_then(|p|std::fs::read_to_string(p.join("desktop-prefs.json")).ok()).and_then(|s|serde_json::from_str(&s).ok()))
        .unwrap_or_else(||serde_json::json!({"shortcut":"Alt+Shift+C","autostart":false}))
}
fn save_preferences(app: &tauri::AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let path=preferences_path(app)?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid preferences path")?).map_err(|e|e.to_string())?;
    let lock=path.with_extension("json.lock");let start=std::time::Instant::now();
    loop {match std::fs::create_dir(&lock){Ok(_)=>break,Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists && start.elapsed().as_secs()<10=>{if std::fs::metadata(&lock).ok().and_then(|m|m.modified().ok()).and_then(|t|t.elapsed().ok()).map(|d|d.as_secs()>30).unwrap_or(false){let _=std::fs::remove_dir(&lock);}else{std::thread::sleep(std::time::Duration::from_millis(40));}},Err(e)=>return Err(e.to_string())}}
    let result=(|| {let mut data=std::fs::read_to_string(&path).ok().map(|s|serde_json::from_str::<serde_json::Value>(&s)).transpose().map_err(|e|e.to_string())?.unwrap_or_else(||serde_json::json!({"version":1}));
        data["desktop"]=value.clone();let tmp=path.with_extension("json.tmp");std::fs::write(&tmp,serde_json::to_vec_pretty(&data).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;std::fs::rename(tmp,&path).map_err(|e|e.to_string())})();
    let _=std::fs::remove_dir(lock);result
}

#[tauri::command]
fn desktop_preferences(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>) -> serde_json::Value {
    let mut prefs = read_preferences(&app);
    prefs["trayAvailable"] = app.tray_by_id("reed-tray").is_some().into();
    prefs["activeShortcut"] = state.0.lock().map(|value| value.clone()).unwrap_or_default().into();
    prefs
}

fn brand_bytes(style:&str,dark:bool)->&'static [u8]{
    match (style, dark) {
        ("illustrated", false) => include_bytes!("../icons/illustrated-light.png"),
        ("illustrated", true) => include_bytes!("../icons/illustrated-dark.png"),
        (_, true) => include_bytes!("../icons/glass-dark.png"),
        _ => include_bytes!("../icons/glass-light.png"),
    }
}
fn brand_icon(style: &str, dark: bool) -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(brand_bytes(style,dark))
}

fn surface_color(dark:bool)->tauri::window::Color{
    if dark {tauri::window::Color(24,33,26,255)}else{tauri::window::Color(247,244,236,255)}
}

#[tauri::command]
fn update_brand_icon(app: tauri::AppHandle, style: String, dark: bool) -> Result<(), String> {
    if !["glass", "illustrated"].contains(&style.as_str()) { return Err("图标风格无效".into()); }
    let prefs=read_preferences(&app);
    let style=prefs["iconStyle"].as_str().filter(|value|["glass","illustrated"].contains(value)).unwrap_or(&style).to_owned();
    let dark=match prefs["theme"].as_str(){Some("dark")=>true,Some("light")=>false,_=>dark};
    let icon=brand_icon(&style,dark).map_err(|e|e.to_string())?;
    if let Some(tray)=app.tray_by_id("reed-tray") { tray.set_icon(Some(icon.clone())).map_err(|e|e.to_string())?; }
    for window in app.webview_windows().values() {
        if ["main","settings"].contains(&window.label()) {
            window.set_background_color(Some(surface_color(dark))).map_err(|e|e.to_string())?;
        }
        window.set_icon(icon.clone()).map_err(|e|e.to_string())?;
        #[cfg(windows)]
        native_ui::taskbar_icon(window,brand_bytes(&style,dark),&format!("{style}-{dark}")).map_err(|e|e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_appearance(app: tauri::AppHandle, style: String, theme: String) -> Result<(), String> {
    if !["glass", "illustrated"].contains(&style.as_str()) || !["system", "light", "dark"].contains(&theme.as_str()) {return Err("外观选项无效".into());}
    let mut prefs=read_preferences(&app);prefs["iconStyle"]=style.into();prefs["theme"]=theme.into();save_preferences(&app,&prefs)?;
    app.emit("desktop-appearance",prefs).map_err(|e|e.to_string())
}

#[tauri::command]
fn ui_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    startup_log(&format!("ui_ready received for {} (visible={})", window.label(), window.is_visible().unwrap_or(false)));
    if window.label() == "main" {
        #[cfg(windows)]
        mark_native_main_window_ready(&window)?;
    }
    let app = window.app_handle();
    app.state::<ReadyWindows>().0.lock().map_err(|_| "Ready window lock failed")?.insert(window.label().to_owned());
    startup_log(&format!("UI ready marked for {}", window.label()));
    if window.label()=="main" && std::env::args().any(|a|a=="--autostart") {return Ok(());}
    window.show().map_err(|e|e.to_string())?;
    startup_log(&format!("ui_ready showed {} (visible={})", window.label(), window.is_visible().unwrap_or(false)));
    if window.label()=="main" {
        // Main is already visible. Initialization runs in the background and is
        // independent of Agent capability switches or opening the first HTML.
        browser_workspace::prewarm(app);
    }
    Ok(())
}

/// 版本号以构建时的 tauri.conf.json 为准，启动动画与「关于」页共用同一来源。
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 构建时是否配置了更新公钥。
/// 公钥只在 tauri.conf.json 里存一份，前端靠这个命令判断能否走应用内一键更新，
/// 从而避免同一个公钥在前端再抄一份、两处漂移。
#[tauri::command]
fn update_key_configured(app: tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(|pubkey| !pubkey.trim().is_empty())
        .unwrap_or(false)
}

/// 只在系统浏览器里打开 https 链接（「关于 → 检查更新」的手动下载入口）。
/// 只接受 https://，避免被当成任意命令或本地路径执行。
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") || trimmed.len() > 2048 {
        return Err("只允许打开 https 链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        extern "system" { fn ShellExecuteW(hwnd: isize, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> isize; }
        let wide: Vec<u16> = std::ffi::OsStr::new(trimmed).encode_wide().chain(Some(0)).collect();
        let open: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(0, open.as_ptr(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if result <= 32 { return Err(format!("无法打开链接（{result}）")); }
        Ok(())
    }
    #[cfg(not(windows))]
    { Err("目前仅支持 Windows 默认浏览器".into()) }
}

#[tauri::command]
fn set_shortcut(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>, shortcut: String) -> Result<String, String> {
    let requested = shortcut.trim();
    if requested.is_empty() || requested.len() > 64 || !requested.is_ascii() {
        return Err("请输入有效的快捷键，例如 Ctrl+Alt+Space".into());
    }
    let mut current = state.0.lock().map_err(|_| "Shortcut lock failed")?;
    if *current != requested {
        app.global_shortcut().register(requested).map_err(|error| format!("快捷键不可用或已被占用：{error}"))?;
        if !current.is_empty() { let _ = app.global_shortcut().unregister(current.as_str()); }
        *current = requested.to_owned();
    }
    let mut prefs = read_preferences(&app);
    prefs["shortcut"] = requested.into();
    save_preferences(&app, &prefs)?;
    Ok(current.clone())
}

#[cfg(windows)]
fn apply_autostart(enabled: bool) -> Result<(), String> {
    if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() { return Ok(()); }
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let mut command = Command::new("reg.exe");
    if enabled {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        command.args(["add", key, "/v", "Reed", "/t", "REG_SZ", "/d"])
            .arg(format!("\"{}\" --autostart", exe.display())).arg("/f");
    } else {
        let existing = Command::new("reg.exe").args(["query", key, "/v", "Reed"])
            .output().map_err(|error| error.to_string())?;
        if !existing.status.success() { return Ok(()); }
        command.args(["delete", key, "/v", "Reed", "/f"]);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("设置开机自启失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let _ = Command::new("reg.exe").args(["delete", key, "/v", "Summon", "/f"]).output();
    Ok(())
}

#[cfg(not(windows))]
fn apply_autostart(_enabled: bool) -> Result<(), String> { Err("开机自启目前仅支持 Windows".into()) }

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    apply_autostart(enabled)?;
    let mut prefs = read_preferences(&app);
    prefs["autostart"] = enabled.into();
    save_preferences(&app, &prefs)
}

fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe_directory = std::env::current_exe().map_err(|error| error.to_string())?
        .parent().ok_or("Executable directory unavailable")?.to_path_buf();
    let resources = if exe_directory.join("agent/bridge.mjs").is_file() { exe_directory }
        else { app.path().resource_dir().map_err(|error| error.to_string())? };
    let node = resources.join("runtime/node.exe");
    let script = resources.join("agent/bridge.mjs");
    if node.is_file() && script.is_file() { return Ok((node, script)); }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/bridge.mjs");
    if source.is_file() { return Ok((PathBuf::from("node"), source)); }
    Err("PI Agent runtime files are missing".into())
}

#[tauri::command]
fn agent_command(app: tauri::AppHandle, state: tauri::State<'_, AgentState>, command: serde_json::Value) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "Agent lock failed".to_string())?;
    if let Some(process) = guard.as_mut() {
        if let Some(status) = process.child.try_wait().map_err(|error| error.to_string())? {
            let errors = process.errors.lock().map(|items| items.join("\n")).unwrap_or_default();
            startup_log(&format!("Agent exited: {status}; stderr: {errors}"));
            *guard = None;
        }
    }
    if guard.is_none() {
        let data_dir = data_directory(&app)?;
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let (node, script) = runtime_paths(&app)?;
        startup_log(&format!("Starting Agent: node={}, script={}, data={}", node.display(), script.display(), data_dir.display()));
        let workspace = app.path().home_dir().map_err(|error| error.to_string())?;
        let mut command_line = Command::new(node);
        command_line.arg(script)
            .env("SUMMON_NATIVE_BROWSER", "1")
            .env("SUMMON_DATA_DIR", &data_dir)
            .env("SUMMON_WORKSPACE", &workspace)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command_line.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command_line.spawn()
            .map_err(|error| format!("Cannot start PI Agent: {error}"))?;
        let stdin = child.stdin.take().ok_or("Agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Agent stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Agent stderr unavailable")?;
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let error_buffer = errors.clone();
        let diagnostic_path = data_dir.join("agent.log");
        let events = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if value["type"] == "native_browser_request" {
                                let host=events.clone();
                                thread::spawn(move || {
                                    let id=value["id"].clone();
                                    let result=browser_workspace::request(host.clone(),value);
                                    let reply=match result {Ok(value)=>serde_json::json!({"type":"native_browser_response","id":id,"value":value}),Err(error)=>serde_json::json!({"type":"native_browser_response","id":id,"error":error})};
                                    if let Ok(mut state)=host.state::<AgentState>().0.lock(){if let Some(process)=state.as_mut(){let _=writeln!(process.stdin,"{}",reply);}}
                                });
                            } else {let _ = events.emit("agent-event", value);}
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = events.emit("agent-event", serde_json::json!({"type":"disconnected","message":"Agent 连接中断，正在恢复"}));
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if let Ok(mut buffer) = error_buffer.lock() { if buffer.len() >= 20 { buffer.remove(0); } buffer.push(line.clone()); }
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&diagnostic_path) { let _ = writeln!(file, "{line}"); }
                startup_log(&format!("Agent stderr: {line}"));
            }
        });
        *guard = Some(AgentProcess { child, stdin, errors });
        if command["type"].as_str() != Some("init") {
            let process = guard.as_mut().ok_or("Agent unavailable")?;
            writeln!(process.stdin, "{}", serde_json::json!({"type":"init","id":"host-init"})).map_err(|error| error.to_string())?;
        }
    }
    let process = guard.as_mut().ok_or("Agent unavailable")?;
    writeln!(process.stdin, "{}", command).map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        if !ui_window_is_ready(&app, "settings") {
            startup_log("Settings activation deferred: UI is not ready");
            return Ok(());
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        let _ = window.emit("settings-section", section.unwrap_or_else(|| "general".into()));
    } else {
        let initial = serde_json::to_string(&section.unwrap_or_else(|| "general".into())).map_err(|error| error.to_string())?;
        let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
            .data_directory(data_directory(&app)?.join("webview"))
            .initialization_script(format!("window.SUMMON_SETTINGS_SECTION={initial};"))
            .title("Reed 苇 · 设置").visible(false).decorations(false).shadow(false).inner_size(980.0, 700.0).min_inner_size(740.0, 480.0);
        #[cfg(windows)]
        if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() {
            if let Ok(port) = std::env::var("SUMMON_TEST_WEBVIEW_PORT") {
                if let Ok(port) = port.parse::<u16>() { builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}")); }
            }
        }
        let settings_window = builder.build().map_err(|error| error.to_string())?;
        round_window(&settings_window);
    }
    Ok(())
}

#[tauri::command]
fn capture_shortcut(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>, active: bool) -> Result<(), String> {
    let current = state.0.lock().map_err(|_| "Shortcut lock failed")?;
    if !current.is_empty() {
        if active { let _ = app.global_shortcut().unregister(current.as_str()); }
        else if !app.global_shortcut().is_registered(current.as_str()) {
            app.global_shortcut().register(current.as_str()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !ui_window_is_ready(app, "main") {
            startup_log("Main activation ignored: UI is not ready");
            return;
        }
        let _ = window.unminimize();
        let _ = window.show();
        browser_workspace::prewarm(app);
        let _ = window.set_focus();
    }
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = app.save_window_state(BOUNDS);
            let _ = window.hide();
        } else {
            show_main(app);
        }
    }
}

#[tauri::command]
fn dismiss(window: tauri::WebviewWindow) {
    let _ = window.app_handle().save_window_state(BOUNDS);
    let _ = window.hide();
}

#[tauri::command]
fn window_pinned(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_always_on_top().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_pinned(window: tauri::WebviewWindow, pinned: bool) -> Result<bool, String> {
    let previous = window.is_always_on_top().map_err(|e| e.to_string())?;
    window.set_always_on_top(pinned).map_err(|e| e.to_string())?;
    let mut prefs = read_preferences(window.app_handle());
    prefs["alwaysOnTop"] = pinned.into();
    if let Err(error) = save_preferences(window.app_handle(), &prefs) {
        let _ = window.set_always_on_top(previous);
        return Err(error);
    }
    Ok(pinned)
}

#[tauri::command]
async fn choose_workspace(window:tauri::WebviewWindow,initial_path:Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let owner=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
        tauri::async_runtime::spawn_blocking(move||native_ui::choose_folder(owner,initial_path.as_deref())).await.map_err(|error|error.to_string())?
    }
    #[cfg(not(windows))]
    { Err("Folder selection is currently available on Windows only".into()) }
}

#[tauri::command]
async fn open_local_file(path: String) -> Result<(), String> {
    let file = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !file.is_file() { return Err("文件不存在".into()); }
    let extension = file.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if !["html", "htm", "md", "txt", "pdf", "png", "jpg", "jpeg", "svg", "csv"].contains(&extension.as_str()) { return Err("不支持直接打开此文件类型".into()); }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        extern "system" { fn ShellExecuteW(hwnd: isize, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> isize; }
        let plain = file.to_string_lossy().trim_start_matches("\\\\?\\").to_owned();
        let wide: Vec<u16> = std::ffi::OsStr::new(&plain).encode_wide().chain(Some(0)).collect();
        let open: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(0, open.as_ptr(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if result <= 32 { return Err(format!("默认应用无法打开文件（{result}）")); }
        Ok(())
    }
    #[cfg(not(windows))]
    { Err("目前仅支持 Windows 默认应用".into()) }
}

fn startup_log(message: &str) {
    let elapsed_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis()).unwrap_or_default();
    let paths = [
        std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("startup.log"))),
        Some(std::env::temp_dir().join("Reed-startup.log")),
    ];
    for path in paths.into_iter().flatten() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[{elapsed_ms}] {message}");
            break;
        }
    }
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let text: Vec<u16> = std::ffi::OsStr::new(message).encode_wide().chain(Some(0)).collect();
    let caption: Vec<u16> = std::ffi::OsStr::new("Reed 苇启动失败").encode_wide().chain(Some(0)).collect();
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10); }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}

#[cfg(windows)]
struct InstanceGuard(isize);

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: isize) -> i32;
        }
        unsafe { CloseHandle(self.0); }
    }
}

#[cfg(windows)]
fn claim_instance() -> Result<Option<InstanceGuard>, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const std::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
        fn GetPropW(window: isize, name: *const u16) -> isize;
        fn GetWindowThreadProcessId(window: isize, process_id: *mut u32) -> u32;
        fn ShowWindow(window: isize, command: i32) -> i32;
        fn SetForegroundWindow(window: isize) -> i32;
    }
    let lock_name = instance_lock_name();
    let ready_property = ready_property_name(&lock_name);
    let name: Vec<u16> = std::ffi::OsStr::new(&lock_name)
        .encode_wide().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle == 0 {
        return Err(format!("Cannot create single-instance lock: {}", std::io::Error::last_os_error()));
    }
    if unsafe { GetLastError() } != 183 {
        return Ok(Some(InstanceGuard(handle)));
    }
    let title: Vec<u16> = std::ffi::OsStr::new("Reed 苇").encode_wide().chain(Some(0)).collect();
    for _ in 0..20 {
        let mut window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if window==0 {
            let legacy: Vec<u16> = std::ffi::OsStr::new("Summon").encode_wide().chain(Some(0)).collect();
            window=unsafe {FindWindowW(std::ptr::null(),legacy.as_ptr())};
        }
        if window != 0 {
            let mut ready = false;
            for _ in 0..20 {
                let mut owner_pid = 0u32;
                let thread_id = unsafe { GetWindowThreadProcessId(window, &mut owner_pid) };
                let property_pid = unsafe { GetPropW(window, ready_property.as_ptr()) } as usize as u32;
                if native_window_is_ready(thread_id, owner_pid, property_pid) {
                    ready = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if ready {
                unsafe {
                    ShowWindow(window, 9);
                    SetForegroundWindow(window);
                }
            } else {
                startup_log("Existing instance window did not become UI-ready within 2 seconds; activation skipped");
            }
            unsafe { CloseHandle(handle); }
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe { CloseHandle(handle); }
    Err("Reed is already running, but its window was not found".into())
}

#[cfg(test)]
mod window_readiness_tests {
    use super::native_window_is_ready;

    #[test]
    fn native_window_requires_ready_property_from_its_own_process() {
        assert!(native_window_is_ready(7, 42, 42));
        assert!(!native_window_is_ready(7, 42, 0));
        assert!(!native_window_is_ready(7, 42, 99));
        assert!(!native_window_is_ready(0, 42, 42));
        assert!(!native_window_is_ready(7, 0, 0));
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "显示 Reed 苇", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Reed 苇", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let prefs=read_preferences(app.handle());
    let dark=prefs["theme"].as_str()==Some("dark") || (prefs["theme"].as_str()!=Some("light") && app.get_webview_window("main").and_then(|w|w.theme().ok())==Some(tauri::Theme::Dark));
    TrayIconBuilder::with_id("reed-tray")
        .icon(brand_icon(prefs["iconStyle"].as_str().unwrap_or("glass"),dark)?)
        .tooltip("Reed 苇 · 一苇以航，轻渡学海。")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                let _ = app.save_window_state(BOUNDS);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn run_desktop() -> tauri::Result<()> {
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main(app);
            }
        })
        .build();

    startup_log(&format!("Preparing user profile: {}", profile::directory()?.display()));
    let profile_dir = profile::prepare()?;
    startup_log(&format!("User profile ready: {}", profile_dir.display()));
    let window_state = tauri_plugin_window_state::Builder::new().with_state_flags(BOUNDS)
        .with_denylist(&["reed-browser-preview","reed-browser-agent"])
        .with_filename(profile_dir.join("window-state.json").to_string_lossy().into_owned());
    tauri::Builder::default()
        .manage(AgentState::default())
        .manage(ShortcutStateStore::default())
        .manage(ReadyWindows::default())
        .manage(BoundsAutosave::default())
        .manage(RoundedBounds::default())
        .manage(canvas_window::CanvasWindow::default())
        .manage(browser_workspace::BrowserWorkspace::default())
        .plugin(window_state.build())
        .plugin(shortcuts)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(move |invoke:tauri::ipc::Invoke|{
                if !["main","settings"].contains(&invoke.message.webview_ref().label()) {invoke.resolver.reject("网页不能调用Reed应用命令");return true;}
                let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![browser_workspace::browser_host,browser_workspace::choose_html_file,canvas_window::workspace_geometry,canvas_window::set_canvas_window,canvas_window::cancel_canvas_transition, dismiss, window_pinned, set_window_pinned, agent_command, choose_workspace, open_local_file, desktop_preferences, set_shortcut, set_autostart, open_settings, capture_shortcut, drag_window, resize_window, update_brand_icon, set_appearance, ui_ready, app_version, update_key_configured, open_external_url]); handler(invoke)
        })
        .setup(|app| {
            startup_log("Creating Tauri window");
            let webview_dir = profile::directory()?.join("webview");
            std::fs::create_dir_all(&webview_dir)?;
            startup_log(&format!("WebView2 data directory: {}", webview_dir.display()));
            let config = &app.config().app.windows[0];
            // Keep the native window hidden until the branded first frame calls ui_ready.
            // Set this on the builder as well as in tauri.conf.json so a future config
            // change cannot expose WebView2's unpainted client area during startup.
            let initial_prefs=read_preferences(app.handle());
            let initial_dark=initial_prefs["theme"].as_str()!=Some("light");
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), config)?.visible(false).decorations(false).shadow(false).background_color(surface_color(initial_dark)).data_directory(webview_dir);
            #[cfg(windows)]
            if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() {
                if let Ok(port) = std::env::var("SUMMON_TEST_WEBVIEW_PORT") {
                    if let Ok(port) = port.parse::<u16>() { builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}")); }
                }
            }
            let main_window = builder.build()?;
            if let Err(error)=canvas_window::restore_collapsed(&main_window){startup_log(&format!("Canvas window recovery failed: {error}"));}
            startup_log(&format!("Main window built (visible={})", main_window.is_visible().unwrap_or(false)));
            round_window(&main_window);
            if std::env::args().any(|arg| arg == "--autostart") {
                let _ = main_window.hide();
            }
            startup_log("Tauri window created");
            if let Err(error) = setup_tray(app) {
                startup_log(&format!("Tray unavailable: {error}"));
            }

            let prefs = read_preferences(app.handle());
            main_window.set_always_on_top(prefs["alwaysOnTop"].as_bool().unwrap_or(false))?;
            let preferred = prefs["shortcut"].as_str().unwrap_or("Alt+Shift+C");
            let mut shortcut = String::new();
            for accelerator in std::iter::once(preferred).chain(["Alt+Shift+C", "Alt+Shift+Q", "Alt+Shift+J", "F3"]) {
                if !shortcut.is_empty() { break; }
                if app.global_shortcut().register(accelerator).is_ok() {
                    shortcut = accelerator.to_owned();
                }
            }
            if let Ok(mut active) = app.state::<ShortcutStateStore>().0.lock() { *active = shortcut.clone(); }
            if std::env::var_os("SUMMON_TEST_DATA_DIR").is_none() && prefs["autostart"].as_bool() == Some(true) {
                if let Err(error) = apply_autostart(true) { startup_log(&error); }
            }
            startup_log(&format!("Global shortcut: {shortcut}"));
            startup_log("Setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label().starts_with("reed-browser-"){return;}
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) { round_window(&webview); }
            }
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                schedule_bounds_save(window.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.app_handle().save_window_state(BOUNDS);
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
}

fn main() {
    startup_log("Starting Reed");
    #[cfg(windows)]
    let _instance_guard = match claim_instance() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            startup_log(&error);
            show_startup_error(&error);
            return;
        }
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run_desktop));
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(error)) => format!("{error:?}"),
        Err(panic) => panic.downcast_ref::<String>().cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|value| (*value).to_string()))
            .unwrap_or_else(|| "Unknown startup panic".to_string()),
    };
    let message = format!("Reed 苇无法启动：{error}\n\n请将便携包文件夹中的 startup.log 发给开发者；若文件不存在，请查看系统临时目录中的 Reed-startup.log。");
    startup_log(&format!("Startup failed: {error}"));
    show_startup_error(&message);
}
