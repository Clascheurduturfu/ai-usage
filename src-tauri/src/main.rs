#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}};
use tauri::{Emitter, Manager, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButtonState, MouseButton}, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::oneshot;

struct Broker {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicU64,
}

#[derive(Default)]
struct SupervisorControl(Mutex<Option<Value>>);

fn supervisor_control(app: &tauri::AppHandle, action: &str, name: &str) -> Result<Value, String> {
    use std::net::{TcpStream, SocketAddr};
    use std::time::Duration;
    if !["stop", "resume"].contains(&action) || name.is_empty() { return Err("Invalid MCP control".into()); }
    let state = app.state::<SupervisorControl>();
    let info = state.0.lock().map_err(|_| "Supervisor unavailable")?.clone().ok_or("MCP supervisor has not started")?;
    let port = info["port"].as_u64().ok_or("Invalid supervisor port")? as u16;
    let address = SocketAddr::from(([127,0,0,1], port));
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|_| "MCP supervisor disconnected")?;
    socket.set_read_timeout(Some(Duration::from_secs(5))).map_err(|_| "Supervisor read failed")?;
    socket.set_write_timeout(Some(Duration::from_secs(3))).map_err(|_| "Supervisor write failed")?;
    writeln!(socket, "{}", json!({"token":info["token"],"action":action,"name":name})).map_err(|_| "Supervisor write failed")?;
    let mut text=String::new();
    BufReader::new(socket).read_line(&mut text).map_err(|_| "Supervisor control timed out")?;
    let result:Value=serde_json::from_str(&text).map_err(|_| "Invalid supervisor response")?;
    if let Some(error)=result["error"].as_str(){return Err(error.into());}
    let _=app.emit("manager:updated", Value::Null);
    if let Some(broker)=app.try_state::<Arc<Broker>>() { let broker=broker.inner().clone(); tauri::async_runtime::spawn(async move { let _=broker.request("mcp:runtimeRefresh", Value::Null).await; }); }
    Ok(result)
}
#[tauri::command]
async fn mcp_control(app: tauri::AppHandle, action: String, name: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || supervisor_control(&app, &action, &name)).await.map_err(|e|e.to_string())?
}

/// The tray lists the quotas pinned on the Overview, in pinned order. The broker
/// formats each line from the same quota cards the dashboard uses.
fn tray_menu(app: &tauri::AppHandle, quotas: &[(String, String)]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "quota-title", if quotas.is_empty() { "No pinned quotas · pin them on the Overview" } else { "Pinned quotas · click for details" }, false, None::<&str>)?)?;
    for (id, text) in quotas { menu.append(&MenuItem::with_id(app, format!("quota-{}", id), text, true, None::<&str>)?)?; }
    for (id, text) in [("refresh-quota", "Refresh quotas"), ("open", "Open AI Usage"), ("sync", "Synchronize agents"), ("rescan", "Rescan usage"), ("stop-mcps", "Stop all MCPs on this device"), ("resume-mcps", "Resume MCPs on next use"), ("quit", "Quit and stop services")] {
        menu.append(&MenuItem::with_id(app, id, text, true, None::<&str>)?)?;
    }
    Ok(menu)
}

#[derive(Default)]
struct TrayQuotaLines(Mutex<Vec<(String, String)>>);

fn refresh_tray_quotas(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(broker) = app.try_state::<Arc<Broker>>() else { return; };
        let Ok(lines) = broker.request("tray:quotas", Value::Null).await else { return; };
        let quotas: Vec<(String, String)> = lines.as_array().map(|items| items.iter().filter_map(|l| Some((l["id"].as_str()?.to_owned(), l["text"].as_str()?.to_owned()))).collect()).unwrap_or_default();
        // Scans emit many updates; rebuilding an unchanged menu would close it while open.
        if let Some(previous) = app.try_state::<TrayQuotaLines>() { let mut last = previous.0.lock().unwrap(); if *last == quotas { return; } *last = quotas.clone(); }
        let Some(tray) = app.tray_by_id("main") else { return; };
        if let Ok(menu) = tray_menu(&app, &quotas) { let _ = tray.set_menu(Some(menu)); }
    });
}

impl Broker {
    fn send(&self, value: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "Backend input unavailable")?;
        writeln!(input, "{}", value).and_then(|_| input.flush()).map_err(|_| "Backend disconnected".into())
    }
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| "Backend busy")?.insert(id, tx);
        if let Err(err) = self.send(json!({"id": id, "method": method, "params": params})) {
            self.pending.lock().unwrap().remove(&id);
            return Err(err);
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(180), rx).await;
        self.pending.lock().unwrap().remove(&id);
        result.map_err(|_| "Operation timed out".to_string())?.map_err(|_| "Backend stopped".to_string())?
    }
}

#[tauri::command]
async fn rpc(method: String, params: Option<Value>, broker: tauri::State<'_, Arc<Broker>>) -> Result<Value, String> {
    broker.request(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder().map(|p| p.to_string()))
        .await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn pick_json_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file().map(|p| p.to_string()))
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err("Path does not exist".into()); }
    if p.is_file() {
        let ext = p.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if !["txt", "md", "json", "toml", "yaml", "yml", "log", "csv", "pdf"].contains(&ext.as_str()) {
            return Err("Open the parent folder to access this file".into());
        }
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())?;
    Ok(String::new())
}

#[cfg(windows)]
fn crypt(value: &str, decrypt: bool) -> Result<String, String> {
    use windows_sys::Win32::{Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN}, Foundation::LocalFree};
    let mut input = if decrypt { STANDARD.decode(value).map_err(|_| "Invalid encrypted credential")? } else { value.as_bytes().to_vec() };
    let blob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if decrypt { CryptUnprotectData(&blob, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptProtectData(&blob, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    input.fill(0);
    if ok == 0 { return Err("Windows could not unlock this credential for the current user".into()); }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _); }
    if decrypt { String::from_utf8(bytes).map_err(|_| "Credential is not UTF-8".into()) } else { Ok(STANDARD.encode(bytes)) }
}

#[cfg(target_os = "macos")]
fn crypt(value: &str, decrypt: bool) -> Result<String, String> {
    use aes_gcm::{Aes256Gcm, Nonce, aead::{Aead, AeadCore, KeyInit, OsRng}};
    use security_framework::passwords::{get_generic_password, set_generic_password};
    const SERVICE: &str = "io.github.clascheurduturfu.aiusage";
    const ACCOUNT: &str = "vault-aes256-v1";
    let mut key = match get_generic_password(SERVICE, ACCOUNT) {
        Ok(key) => key,
        Err(error) if error.code() == -25300 && !decrypt => {
            let key = Aes256Gcm::generate_key(OsRng).to_vec();
            set_generic_password(SERVICE, ACCOUNT, &key).map_err(|error| format!("macOS Keychain could not save AI Usage credentials ({}). Unlock your login keychain in Keychain Access, then retry Import or Sign in.", error.code()))?;
            key
        },
        Err(_) => return Err("Unlock macOS Keychain to access AI Usage credentials".into()),
    };
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "Invalid Keychain vault key")?;
    key.fill(0);
    if decrypt {
        let payload = value.strip_prefix("mac-v1:").ok_or("Credential belongs to another operating system; use encrypted sharing to import it")?;
        let bytes = STANDARD.decode(payload).map_err(|_| "Invalid encrypted credential")?;
        if bytes.len() < 28 { return Err("Invalid encrypted credential".into()); }
        let plaintext = cipher.decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..]).map_err(|_| "Unable to decrypt the saved credential")?;
        String::from_utf8(plaintext).map_err(|_| "Credential is not UTF-8".into())
    } else {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, value.as_bytes()).map_err(|_| "Unable to encrypt credential")?;
        let mut bytes = nonce.to_vec(); bytes.extend(ciphertext);
        Ok(format!("mac-v1:{}", STANDARD.encode(bytes)))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn crypt(_value: &str, _decrypt: bool) -> Result<String, String> {
    Err("Native keychain support is required for this platform".into())
}

#[cfg(windows)]
fn desktop_policy(method: &str, value: &str) -> Result<Value, String> {
    use winreg::{RegKey, enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE}};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let paths = ["Software\\Policies\\Claude", "Software\\Policies\\Anthropic\\Claude"];
    let names = ["inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceGatewayAuthScheme", "inferenceCredentialKind", "deploymentMode", "disableDeploymentModeChooser", "inferenceModels"];
    let mut snapshot = serde_json::Map::new();
    for path in paths {
        let mut fields = serde_json::Map::new();
        if let Ok(key) = root.open_subkey_with_flags(path, KEY_READ) {
            for name in names {
                let value = if name == "disableDeploymentModeChooser" { key.get_value::<u32, _>(name).ok().map(|v| json!(v)) }
                    else { key.get_value::<String, _>(name).ok().map(Value::String) };
                fields.insert(name.into(), value.unwrap_or(Value::Null));
            }
        } else { for name in names { fields.insert(name.into(), Value::Null); } }
        snapshot.insert(path.into(), Value::Object(fields));
    }
    if method == "desktop-read" { return Ok(Value::String(Value::Object(snapshot).to_string())); }
    let data: Value = serde_json::from_str(value).map_err(|_| "Invalid policy payload")?;
    if method == "desktop-restore" {
        for path in paths { for name in names {
            if snapshot[path][name] != data["after"][name] { return Err("Desktop policy has newer edits; restore was refused".into()); }
        } }
    }
    let write_values = |restoring: bool| -> Result<(), String> {
        for path in paths {
            let (key, _) = root.create_subkey_with_flags(path, KEY_READ | KEY_WRITE).map_err(|_| "Windows denied access to Claude Desktop policies")?;
            for name in names {
                let desired = if restoring { &data["before"][path][name] } else { &data[name] };
                if desired.is_null() { let _ = key.delete_value(name); }
                else if name == "disableDeploymentModeChooser" { key.set_value(name, &(desired.as_u64().unwrap_or(1) as u32)).map_err(|_| "Unable to write desktop policy")?; }
                else { key.set_value(name, &desired.as_str().ok_or("Invalid policy field")?).map_err(|_| "Unable to write desktop policy")?; }
            }
        }
        Ok(())
    };
    if let Err(error) = write_values(method == "desktop-restore") {
        for path in paths {
            if let Ok(key) = root.open_subkey_with_flags(path, KEY_WRITE) {
                for name in names { let old = &snapshot[path][name]; if old.is_null() { let _ = key.delete_value(name); }
                    else if name == "disableDeploymentModeChooser" { let _ = key.set_value(name, &(old.as_u64().unwrap_or(0) as u32)); }
                    else { let _ = key.set_value(name, &old.as_str().unwrap_or("")); } }
            }
        }
        return Err(error);
    }
    Ok(Value::String(String::new()))
}

#[cfg(target_os = "macos")]
fn desktop_policy(method: &str, value: &str) -> Result<Value, String> {
    const DOMAIN: &str = "com.anthropic.claudefordesktop";
    let names = ["inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceGatewayAuthScheme", "inferenceCredentialKind", "deploymentMode", "disableDeploymentModeChooser", "inferenceModels"];
    let output = Command::new("/usr/bin/defaults").args(["export", DOMAIN, "-"]).output().map_err(|_| "Cannot read Claude Desktop preferences")?;
    let mut document = if output.status.success() { plist::Value::from_reader(std::io::Cursor::new(output.stdout)).map_err(|_| "Invalid Claude Desktop preference file")? } else { plist::Value::Dictionary(plist::Dictionary::new()) };
    let fields = document.as_dictionary_mut().ok_or("Invalid Claude Desktop preferences")?;
    let mut snapshot = serde_json::Map::new();
    for name in names {
        let field = fields.get(name).map(|v| match v { plist::Value::String(s) => Value::String(s.clone()), plist::Value::Boolean(v) => json!(*v as u32), plist::Value::Integer(i) => json!(i.as_unsigned().unwrap_or(0)), _ => Value::Null }).unwrap_or(Value::Null);
        snapshot.insert(name.into(), field);
    }
    if method == "desktop-read" { return Ok(Value::String(json!({ DOMAIN: snapshot }).to_string())); }
    let data: Value = serde_json::from_str(value).map_err(|_| "Invalid policy payload")?;
    let restoring = method == "desktop-restore";
    if restoring && names.iter().any(|name| snapshot[*name] != data["after"][*name]) { return Err("Claude Desktop preferences have newer edits; standard profile was refused".into()); }
    for name in names {
        let desired = if restoring { &data["before"][DOMAIN][name] } else { &data[name] };
        if desired.is_null() { fields.remove(name); }
        else if name == "disableDeploymentModeChooser" { fields.insert(name.into(), plist::Value::Boolean(desired.as_u64().unwrap_or(1) != 0)); }
        else { fields.insert(name.into(), plist::Value::String(desired.as_str().ok_or("Invalid preference value")?.into())); }
    }
    let mut bytes = Vec::new(); document.to_writer_xml(&mut bytes).map_err(|_| "Cannot encode Claude Desktop preferences")?;
    // Keep credentials off command-line arguments. defaults talks to cfprefsd
    // and preserves the unrelated fields collected above.
    let mut child = Command::new("/usr/bin/defaults").args(["import", DOMAIN, "-"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "Cannot save Claude Desktop preferences")?;
    child.stdin.take().unwrap().write_all(&bytes).map_err(|_| "Cannot write preferences")?;
    bytes.fill(0);
    if !child.wait().map_err(|_| "Cannot finish preference update")?.success() { return Err("macOS denied access to Claude Desktop preferences".into()); }
    Ok(Value::String(String::new()))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn desktop_policy(_method: &str, _value: &str) -> Result<Value, String> { Err("Claude Desktop policy adapter is Windows-only".into()) }

#[cfg(windows)]
fn desktop_with_elevation(method: &str, value: &str) -> Result<Value, String> {
    match desktop_policy(method, value) {
        Err(error) if error.contains("denied access") => {
            let directory = std::path::PathBuf::from(std::env::var("USERPROFILE").map_err(|_| "User folder unavailable")?).join("Desktop/agent");
            std::fs::create_dir_all(&directory).map_err(|_| "Unable to create elevation helper")?;
            let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let payload = directory.join(format!("aiu-desktop-{}.protected.json", id));
            let status = directory.join(format!("aiu-desktop-{}.result.json", id));
            let helper = directory.join(format!("aiu-desktop-{}.bat", id));
            let before = desktop_policy("desktop-read", "")?;
            let request = json!({"method": method, "protected": crypt(value, false)?, "protectedExpected": crypt(before.as_str().ok_or("Policy snapshot unavailable")?, false)?});
            std::fs::write(&payload, request.to_string()).map_err(|_| "Unable to save protected policy request")?;
            let quote = |text: &str| format!("'{}'", text.replace('\'', "''"));
            let exe = runtime_path(std::env::current_exe().map_err(|_| "Application path unavailable")?);
            let args = format!("\"--desktop-policy-file={}\" \"--desktop-policy-result={}\"", payload.display(), status.display());
            let script = format!("try {{ $p=Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }} catch {{ [IO.File]::WriteAllText({}, '{{\"ok\":false,\"error\":\"Windows approval was declined or failed\"}}'); exit 1 }}", quote(&exe.to_string_lossy()), quote(&args), quote(&status.to_string_lossy()));
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let batch = format!("@echo off\r\ntitle AI Usage - Claude Desktop Windows approval\r\necho Claude Desktop policy {} needs Windows administrator approval.\r\necho Your previous policy has been backed up.\r\necho Press a key, then approve the Windows prompt.\r\npause >nul\r\npowershell.exe -NoProfile -EncodedCommand {}\r\nif errorlevel 1 echo Approval failed. Return to AI Usage and retry.\r\npause\r\n", if method == "desktop-restore" { "restore" } else { "setup" }, STANDARD.encode(bytes));
            std::fs::write(&helper, batch).map_err(|_| "Unable to write elevation helper")?;
            use std::os::windows::process::CommandExt;
            Command::new("cmd.exe").arg("/c").arg(&helper).creation_flags(0x00000010).spawn().map_err(|_| "Unable to open the approval terminal")?;
            Ok(Value::String(json!({"pending": true, "statusFile": status, "helper": helper}).to_string()))
        }
        result => result,
    }
}

#[cfg(not(windows))]
fn desktop_with_elevation(method: &str, value: &str) -> Result<Value, String> { desktop_policy(method, value) }

fn profile_directory() -> std::path::PathBuf {
    if let Some(profile) = std::env::args().find_map(|a| a.strip_prefix("--profile=").map(str::to_owned)) { return profile.into(); }
    if cfg!(target_os = "macos") { return std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/AI Usage"); }
    std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("AI Usage for Windows")
}

fn pool_directory() -> std::path::PathBuf {
    std::env::var("AIU_POOL").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from(std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()).join(".agents"))
}

/// Relays and coding agents can start AI Usage from inside their own MSIX package
/// (Codex, Claude desktop). Windows then redirects AppData writes into that
/// package's private LocalCache, and the app disappears with the client. Relaunch
/// through Explorer so the app always runs as an ordinary desktop process.
#[cfg(windows)]
fn escape_package_sandbox() -> bool {
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;
    let mut length = 0u32;
    if unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) } == APPMODEL_ERROR_NO_PACKAGE { return false; }
    // Development profiles and helper modes keep their arguments; only normal launches relaunch.
    if std::env::args().skip(1).any(|a| a != "--hidden") { return false; }
    let Ok(exe) = std::env::current_exe().map(runtime_path) else { return false; };
    // A copy installed inside another package's LocalCache does not exist outside it.
    if sandboxed_install(&exe) { return false; }
    if std::env::args().any(|a| a == "--hidden") { let _ = std::fs::write(pool_directory().join("start-hidden.flag"), std::process::id().to_string()); }
    Command::new("explorer.exe").arg(exe).spawn().is_ok()
}

fn sandboxed_install(exe: &std::path::Path) -> bool {
    let text = exe.to_string_lossy().to_lowercase().replace('/', "\\");
    text.contains(r"\appdata\local\packages\") && text.contains(r"\localcache\")
}

/// A second launch only shows the dashboard when a person asked for it. Relays and the
/// CLI relaunch with --hidden (or the Explorer hidden flag) after a dropped connection.
fn second_launch_wants_window(argv: &[String]) -> bool { !argv.iter().any(|a| a == "--hidden") && !take_hidden_flag() }

/// Explorer cannot pass --hidden, so an escaped relay launch leaves a short-lived flag.
fn take_hidden_flag() -> bool {
    let flag = pool_directory().join("start-hidden.flag");
    let fresh = std::fs::metadata(&flag).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() < 120);
    let _ = std::fs::remove_file(&flag);
    fresh
}

fn runtime_path(value: std::path::PathBuf) -> std::path::PathBuf {
    // Node's module loader does not accept the extended Windows prefix returned by current_exe.
    let text = value.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { return format!(r"\\{}", unc).into(); }
    text.strip_prefix(r"\\?\").unwrap_or(&text).into()
}

fn open_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    { let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular); let _ = app.set_dock_visibility(true); }
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); return; }
    let saved: Value = std::fs::read_to_string(profile_directory().join("window.json")).ok().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Value::Null);
    let width = saved["width"].as_f64().unwrap_or(1440.0).clamp(760.0, 3840.0);
    let height = saved["height"].as_f64().unwrap_or(920.0).clamp(600.0, 2160.0);
    if let Ok(window) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(format!("AI Usage v{}", env!("CARGO_PKG_VERSION").replace(".0-beta.", "-beta-").replace(".0-rc.", "-rc-"))).inner_size(width, height).min_inner_size(760.0, 600.0).visible(false).build() {
        if let (Some(x), Some(y)) = (saved["x"].as_i64(), saved["y"].as_i64()) {
            let visible = window.available_monitors().unwrap_or_default().iter().any(|m| {
                let p = m.position(); let s = m.size(); x >= p.x as i64 && y >= p.y as i64 && x < p.x as i64 + s.width as i64 && y < p.y as i64 + s.height as i64
            });
            if visible { let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32)); }
        }
        if saved["maximized"].as_bool().unwrap_or(false) { let _ = window.maximize(); }
        let _ = window.show();
    }
}

#[tauri::command]
fn open_dashboard(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("quota-popover") { let _ = window.hide(); }
    open_window(&app);
}

#[tauri::command]
fn hide_popover(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("quota-popover") { let _ = window.hide(); }
}

fn toggle_popover(app: &tauri::AppHandle, position: tauri::PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("quota-popover") {
        if window.is_visible().unwrap_or(false) { let _ = window.hide(); return; }
        // Destroy the hidden view before reopening so it doesn't keep timers alive.
        let _ = window.destroy();
    }
    if let Ok(window) = WebviewWindowBuilder::new(app, "quota-popover", WebviewUrl::App("index.html?popover=1".into()))
        .title("AI Usage · Capacity").inner_size(390.0, 580.0).decorations(false).resizable(false)
        .always_on_top(true).skip_taskbar(true).visible(false).build() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let mut x = position.x - 195.0 * scale;
        let mut y = position.y + 16.0 * scale;
        if let Some(monitor) = window.available_monitors().unwrap_or_default().iter().find(|m| {
            let p = m.position(); let s = m.size(); position.x >= p.x as f64 && position.x < (p.x as i64 + s.width as i64) as f64 && position.y >= p.y as f64 && position.y < (p.y as i64 + s.height as i64) as f64
        }) {
            let p = monitor.position(); let s = monitor.size();
            let right = (p.x as f64 + s.width as f64 - 390.0 * scale - 8.0).max(p.x as f64 + 8.0);
            let bottom = (p.y as f64 + s.height as f64 - 580.0 * scale - 8.0).max(p.y as f64 + 8.0);
            x = x.clamp(p.x as f64 + 8.0, right); y = y.clamp(p.y as f64 + 8.0, bottom);
        }
        let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        let _ = window.show(); let _ = window.set_focus();
    }
}

fn start_broker(app: &tauri::AppHandle) -> Result<Arc<Broker>, Box<dyn std::error::Error>> {
    let resource = app.path().resource_dir()?;
    let exe_dir = std::env::current_exe()?.parent().unwrap().to_owned();
    let mut node = exe_dir.join(if cfg!(windows) { "aiu-node.exe" } else { "aiu-node" });
    let mut script = resource.join("backend/broker.mjs");
    if cfg!(debug_assertions) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        if !node.exists() { node = root.join(if cfg!(windows) { "binaries/aiu-node-x86_64-pc-windows-msvc.exe" } else if cfg!(target_arch = "aarch64") { "binaries/aiu-node-aarch64-apple-darwin" } else { "binaries/aiu-node-x86_64-apple-darwin" }); }
        if !script.exists() { script = root.join("../out/backend/broker.mjs"); }
    }
    let mut command = Command::new(node);
    let directory = profile_directory(); std::fs::create_dir_all(&directory)?;
    let diagnostic = std::fs::File::create(directory.join("broker-startup.log"))?;
    command.arg(runtime_path(script)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(diagnostic));
    for arg in std::env::args().skip(1) {
        if let Some(profile) = arg.strip_prefix("--profile=") { command.env("AIU_PROFILE", profile); }
        if arg == "--offline" { command.env("AIU_OFFLINE", "1"); }
    }
    command.env("AIU_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("AIU_HOST_EXE", runtime_path(std::env::current_exe()?));
    if sandboxed_install(&runtime_path(std::env::current_exe()?)) { command.env("AIU_SANDBOXED_INSTALL", "1"); }
    #[cfg(target_os = "macos")] {
        let old = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        command.env("PATH", format!("{}:/opt/homebrew/bin:/usr/local/bin:{}/.local/bin:{}/.cargo/bin:{}", exe_dir.display(), home, home, old));
    }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let broker = Arc::new(Broker { input: Mutex::new(child.stdin.take().unwrap()), child: Mutex::new(child), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    let cloned = broker.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue; };
            if let Some(native_id) = frame.get("nativeId") {
                let value = frame["value"].as_str().unwrap_or("");
                let result = match frame["native"].as_str().unwrap_or("") {
                    "mcp-supervisor" => serde_json::from_str::<Value>(value).map_err(|_| "Invalid supervisor handshake".to_string()).and_then(|info| { *app.state::<SupervisorControl>().0.lock().map_err(|_| "Supervisor unavailable")?=Some(info); Ok(Value::Null) }),
                    "protect" => crypt(value, false).map(Value::String),
                    "unprotect" => crypt(value, true).map(Value::String),
                    "notify" => app.notification().builder().title("AI Usage").body(value).show().map(|_| Value::Null).map_err(|e| e.to_string()),
                    "open-url" => app.opener().open_url(value, None::<&str>).map(|_| Value::Null).map_err(|e| e.to_string()),
                    "launch-terminal" => {
                        #[cfg(target_os = "macos")]
                        { Command::new("/usr/bin/open").args(["-a", "Terminal", value]).status().map_err(|_| "Unable to open Terminal".to_string()).and_then(|status| if status.success() { Ok(Value::Null) } else { Err("Unable to open Terminal".into()) }) }
                        #[cfg(not(target_os = "macos"))]
                        { Err("Native terminal handoff is macOS-only".into()) }
                    },
                    "desktop-read" | "desktop-apply" | "desktop-restore" => desktop_with_elevation(frame["native"].as_str().unwrap(), value),
                    "autostart" => {
                        let result = if value == "true" { app.autolaunch().enable() } else { app.autolaunch().disable() };
                        result.map(|_| Value::Null).map_err(|e| e.to_string())
                    },
                    _ => Err("Unknown native operation".into())
                };
                let response = match result { Ok(v) => json!({"nativeId": native_id, "result": v}), Err(e) => json!({"nativeId": native_id, "error": e}) };
                let _ = cloned.send(response);
            } else if let Some(event) = frame["event"].as_str() {
                let _ = app.emit(event, frame.get("data").unwrap_or(&Value::Null));
                if event == "data:updated" { refresh_tray_quotas(app.clone()); }
            } else if let Some(id) = frame["id"].as_u64() {
                if let Some(tx) = cloned.pending.lock().unwrap().remove(&id) {
                    let result = if let Some(err) = frame["error"].as_str() { Err(err.to_string()) } else { Ok(frame["result"].clone()) };
                    let _ = tx.send(result);
                }
            }
        }
        let mut pending = cloned.pending.lock().unwrap();
        for (_, tx) in pending.drain() { let _ = tx.send(Err("Backend stopped unexpectedly".into())); }
        let _ = app.emit("backend:error", "Backend stopped unexpectedly");
    });
    Ok(broker)
}

fn main() {
    if let Some(file) = std::env::args().find_map(|a| a.strip_prefix("--desktop-policy-file=").map(str::to_owned)) {
        let output = std::env::args().find_map(|a| a.strip_prefix("--desktop-policy-result=").map(str::to_owned));
        let result = (|| -> Result<(), String> {
            let text = std::fs::read_to_string(&file).map_err(|_| "Protected request unavailable")?;
            let request: Value = serde_json::from_str(&text).map_err(|_| "Invalid request")?;
            let method = request["method"].as_str().unwrap_or("");
            if !["desktop-apply", "desktop-restore"].contains(&method) { return Err("Invalid policy operation".into()); }
            let value = crypt(request["protected"].as_str().ok_or("Missing protected request")?, true)?;
            let expected = crypt(request["protectedExpected"].as_str().ok_or("Missing expected policy")?, true)?;
            let current = desktop_policy("desktop-read", "")?;
            if current.as_str() != Some(expected.as_str()) { return Err("Desktop policy changed while Windows approval was pending".into()); }
            desktop_policy(method, &value)?;
            Ok(())
        })();
        let status = match &result { Ok(_) => json!({"ok": true}), Err(error) => json!({"ok": false, "error": error}) };
        if let Some(output) = output { let _ = std::fs::write(output, status.to_string()); }
        let _ = std::fs::remove_file(file);
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if let Some(reference) = std::env::args().find_map(|a| a.strip_prefix("--credential-ref=").map(str::to_owned)) {
        let profile = std::env::args().find_map(|a| a.strip_prefix("--profile=").map(str::to_owned));
        let result = (|| -> Result<String, String> {
            let directory = profile.ok_or("Credential profile missing")?;
            if reference.is_empty() { return Ok(String::new()); }
            let data = std::fs::read_to_string(std::path::Path::new(&directory).join("vault.json")).map_err(|_| "Vault unavailable")?;
            let vault: Value = serde_json::from_str(&data).map_err(|_| "Vault invalid")?;
            crypt(vault[reference].as_str().ok_or("Credential unavailable")?, true)
        })();
        match result { Ok(secret) => { let _ = writeln!(std::io::stdout(), "{}", secret); }, Err(_) => std::process::exit(1) }
        return;
    }
    // Upgrade helpers pass credentials through a private pipe, never argv or files.
    if std::env::args().any(|a|a=="--vault-import-stdin") {
        let result=(|| -> Result<usize,String> {
            use std::io::Read;
            let mut payload=String::new();std::io::stdin().take(16*1024*1024+1).read_to_string(&mut payload).map_err(|_|"Migration input unavailable")?;
            if payload.len()>16*1024*1024{return Err("Migration input too large".into())}
            let credentials:Value=serde_json::from_str(&payload).map_err(|_|"Invalid migration input")?;
            let entries=credentials.as_object().ok_or("Invalid migration credentials")?;
            if entries.len()>256{return Err("Too many migration credentials".into())}
            let mut vault=serde_json::Map::new();
            for (reference,value) in entries {if reference.is_empty()||reference.len()>128||!reference.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'||b==b'.'){return Err("Invalid credential reference".into())}
                let secret=value.as_str().ok_or("Invalid migration credential")?;if secret.len()>128000{return Err("Migration credential too large".into())}
                vault.insert(reference.clone(),Value::String(crypt(secret,false)?));
            }
            let directory=profile_directory();std::fs::create_dir_all(&directory).map_err(|_|"Migration directory unavailable")?;
            let temp=directory.join("vault-migration.tmp");std::fs::write(&temp,Value::Object(vault).to_string()).map_err(|_|"Cannot stage migrated vault")?;
            #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&temp,std::fs::Permissions::from_mode(0o600)).map_err(|_|"Cannot protect migrated vault")?;}
            std::fs::rename(&temp,directory.join("vault.json")).map_err(|_|"Cannot replace migrated vault")?;
            Ok(entries.len())
        })();
        match result {Ok(count)=>{println!("{}",json!({"migrated":count}));return},Err(error)=>{eprintln!("{}",error);std::process::exit(1)}}
    }
    #[cfg(windows)]
    if escape_package_sandbox() { return; }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| if second_launch_wants_window(&argv) { open_window(app) }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build())
        .invoke_handler(tauri::generate_handler![mcp_control, rpc, pick_folder, pick_json_file, open_path, open_dashboard, hide_popover])
        .on_window_event(|window, event| {
            if window.label() == "quota-popover" {
                if matches!(event, tauri::WindowEvent::Focused(false)) { let _ = window.destroy(); }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let (Ok(size), Ok(position), Ok(scale)) = (window.inner_size(), window.outer_position(), window.scale_factor()) {
                    let directory = profile_directory(); let _ = std::fs::create_dir_all(&directory);
                    let value = json!({"width": size.width as f64 / scale, "height": size.height as f64 / scale, "x": position.x, "y": position.y, "maximized": window.is_maximized().unwrap_or(false)});
                    let _ = std::fs::write(directory.join("window.json"), value.to_string());
                }
            }
            #[cfg(target_os = "macos")]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                let _ = window.app_handle().set_dock_visibility(false);
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            { app.set_activation_policy(tauri::ActivationPolicy::Accessory); app.set_dock_visibility(false); }
            app.manage(SupervisorControl::default());
            app.manage(TrayQuotaLines::default());
            let broker = start_broker(app.handle())?;
            app.manage(broker);
            // Only the primary instance reaches setup, so the Explorer hidden flag is read here.
            let start_hidden = std::env::args().any(|a| a == "--hidden") | take_hidden_flag();
            let menu = tray_menu(app.handle(), &[])?;
            TrayIconBuilder::with_id("main").icon(app.default_window_icon().unwrap().clone()).tooltip(format!("AI Usage v{} · quotas and agent sync", env!("CARGO_PKG_VERSION")))
                .menu(&menu).show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                        #[cfg(target_os = "macos")] toggle_popover(tray.app_handle(), position);
                        #[cfg(not(target_os = "macos"))] { let _ = position; open_window(tray.app_handle()); }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_window(app),
                    id if id.starts_with("quota-") => { if let Ok(position) = app.cursor_position() { toggle_popover(app, position); } },
                    "quit" => app.exit(0),
                    "stop-mcps" | "resume-mcps" => {
                        let action=if event.id.as_ref()=="stop-mcps" { "stop" } else { "resume" };
                        let app=app.clone();
                        tauri::async_runtime::spawn_blocking(move || { let _=supervisor_control(&app, action, "*"); });
                    },
                    id => {
                        let app = app.clone();
                        let method = match id { "sync" => "manager:sync", "refresh-quota" => "quota:refresh", _ => "scan:full" };
                        tauri::async_runtime::spawn(async move { let broker = app.state::<Arc<Broker>>(); let _ = broker.request(method, Value::Null).await; });
                    }
                }).build(app)?;
            refresh_tray_quotas(app.handle().clone());
            if !start_hidden {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let broker = handle.state::<Arc<Broker>>();
                    let settings = broker.request("settings:get", Value::Null).await.unwrap_or(Value::Null);
                    if !settings["startMinimized"].as_bool().unwrap_or(false) { open_window(&handle); }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Unable to initialize AI Usage")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event { api.prevent_exit(); }
            if let tauri::RunEvent::Exit = event {
                let broker = app.state::<Arc<Broker>>();
                let _ = broker.send(json!({"id": 0, "method": "app:shutdown"}));
                let mut child = broker.child.lock().unwrap();
                for _ in 0..30 {
                    if child.try_wait().ok().flatten().is_some() { return; }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let _ = child.kill(); let _ = child.wait();
            }
        });
}
