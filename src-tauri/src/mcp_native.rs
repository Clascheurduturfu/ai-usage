use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
mod process_tree;
use process_tree::Tree;
type Writer = Arc<Mutex<TcpStream>>;
/// Runaway guard only, far above any real number of open sessions × servers.
const MAX_WORKERS: usize = 256;
struct Worker {
    name: String,
    kind: String,
    pid: u32,
    marker: String,
    input: Mutex<std::process::ChildStdin>,
    tree: Tree,
}
struct State {
    workers: Mutex<HashMap<String, Arc<Worker>>>,
    paused: Mutex<HashSet<String>>,
    data: std::path::PathBuf,
    pool: std::path::PathBuf,
    token: String,
}
fn send(out: &Writer, value: Value) {
    if let Ok(mut stream) = out.lock() {
        let _ = writeln!(stream, "{}", value);
    }
}
fn line(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let part = reader.fill_buf()?;
        if part.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| std::io::ErrorKind::InvalidData.into())
            };
        }
        let take = part
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(part.len());
        if bytes.len() + take > 16 * 1024 * 1024 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let done = part[take - 1] == b'\n';
        bytes.extend_from_slice(&part[..take]);
        reader.consume(take);
        if done {
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| std::io::ErrorKind::InvalidData.into());
        }
    }
}
impl State {
    fn stop(&self, id: &str) {
        let worker = self.workers.lock().unwrap().remove(id);
        if let Some(w) = worker {
            w.tree.terminate(&w.marker);
        }
        self.journal();
    }
    fn journal(&self) {
        #[cfg(target_os = "macos")]
        {
            let workers = self.workers.lock().unwrap();
            let _ = self.write_journal(&workers, None);
        }
    }
    #[cfg(target_os = "macos")]
    fn write_journal(
        &self,
        workers: &HashMap<String, Arc<Worker>>,
        pending: Option<&str>,
    ) -> std::io::Result<()> {
        let mut entries: Vec<_> = workers
            .values()
            .map(|w| json!({"marker":w.marker,"pid":w.pid}))
            .collect();
        if let Some(marker) = pending {
            entries.push(json!({"marker":marker,"pid":0}));
        }
        let payload = json!({"supervisor":std::process::id(),"identity":process_tree::process_identity(std::process::id()),"workers":entries});
        let file = self.data.join("mcp-workers.json");
        let temp = self.data.join("mcp-workers.tmp");
        use std::os::unix::fs::PermissionsExt;
        let mut output = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)?;
        output.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        write!(output, "{}", payload)?;
        output.sync_all()?;
        std::fs::rename(temp, file)
    }
    fn pause(&self, name: &str, paused: bool) {
        let mut names: Vec<String> = if name == "*" {
            std::fs::read_to_string(self.pool.join("mcp.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| {
                    v["mcpServers"]
                        .as_object()
                        .map(|o| o.keys().cloned().collect())
                })
                .unwrap_or_default()
        } else {
            vec![name.into()]
        };
        if name == "*" {
            names.extend(
                self.workers
                    .lock()
                    .unwrap()
                    .values()
                    .map(|w| w.name.clone()),
            );
        }
        {
            let mut set = self.paused.lock().unwrap();
            if paused {
                set.extend(names);
            } else if name == "*" {
                set.clear();
            } else {
                set.remove(name);
            }
            let file = self.data.join("mcp-paused.json");
            let tmp = self.data.join("mcp-paused.tmp");
            if let Ok(mut f) = std::fs::File::create(&tmp) {
                let _ = write!(f, "{}", json!({"paused": &*set}));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
                }
                let _ = std::fs::rename(tmp, file);
            }
        }
        if paused {
            let ids: Vec<_> = self
                .workers
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, w)| name == "*" || w.name == name)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                self.stop(&id);
            }
        }
    }
    fn snapshot(&self) -> Value {
        let workers: Vec<_> = self
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(id, w)| (id.clone(), w.clone()))
            .collect();
        json!({"paused": &*self.paused.lock().unwrap(), "workers": workers.iter().map(|(id,w)| json!({"id":id,"name":w.name,"kind":w.kind,"pid":w.pid,"memoryBytes":w.tree.memory(),"processes":w.tree.pids().len()})).collect::<Vec<_>>()})
    }
}
fn serve(mut stream: TcpStream, state: Arc<State>) {
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(copy) = stream.try_clone() else {
        return;
    };
    let out = Arc::new(Mutex::new(copy));
    let mut reader = BufReader::new(&mut stream);
    let Ok(Some(first)) = line(&mut reader) else {
        return;
    };
    let Ok(frame) = serde_json::from_str::<Value>(&first) else {
        return;
    };
    if frame["token"].as_str() != Some(state.token.as_str()) {
        return;
    }
    let action = frame["action"].as_str().unwrap_or("");
    if action == "release" {
        if let Some(id) = frame["id"].as_str() {
            state.stop(id);
        }
        send(&out, state.snapshot());
        return;
    }
    if action == "status" {
        send(&out, state.snapshot());
        return;
    }
    if action == "stop" || action == "resume" {
        let name = frame["name"].as_str().unwrap_or("");
        if !name.is_empty() {
            state.pause(name, action == "stop");
        }
        send(&out, state.snapshot());
        return;
    }
    if action != "spawn" {
        return;
    }
    let id = frame["id"].as_str().unwrap_or("").to_owned();
    let name = frame["name"].as_str().unwrap_or("").to_owned();
    let kind = frame["kind"].as_str().unwrap_or("stateful").to_owned();
    if id.is_empty()
        || id.len() > 80
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || name.is_empty()
    {
        send(&out, json!({"error":"Invalid worker identifier"}));
        return;
    }
    let paused = {
        let set = state.paused.lock().unwrap();
        set.contains(&name) || set.contains("*")
    };
    if paused {
        send(
            &out,
            json!({"error":"MCP paused on this device; Resume in AI Usage"}),
        );
        return;
    }
    let mut workers = state.workers.lock().unwrap();
    if state.paused.lock().unwrap().contains(&name) {
        send(
            &out,
            json!({"error":"MCP paused on this device; Resume in AI Usage"}),
        );
        return;
    }
    // No per-kind or per-server quota: every client session gets its own stateful worker,
    // however many sessions are open. This only stops a runaway client from spawning
    // processes without end.
    if workers.len() >= MAX_WORKERS {
        send(
            &out,
            json!({"error":format!("Too many MCP workers ({MAX_WORKERS}) are running. Close unused agent sessions or stop an MCP in AI Usage.")}),
        );
        return;
    }
    if workers.contains_key(&id) {
        send(&out, json!({"error":"Worker already exists"}));
        return;
    }
    let Some(command) = frame["command"].as_str() else {
        return;
    };
    let mut cmd = Command::new(command);
    for arg in frame["args"].as_array().into_iter().flatten() {
        let Some(arg) = arg.as_str() else {
            return;
        };
        cmd.arg(arg);
    }
    for (key, value) in frame["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            cmd.env(key, value);
        }
    }
    let marker = id.clone();
    cmd.env("__AI_USAGE_WORKER_UUID", &marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = frame["cwd"].as_str() {
        cmd.current_dir(cwd);
    }
    #[cfg(target_os = "macos")]
    if state.write_journal(&workers, Some(&marker)).is_err() {
        send(
            &out,
            json!({"error":"Cannot record worker ownership safely; check app data permissions/storage"}),
        );
        return;
    }
    match Tree::spawn(&mut cmd) {
        Err(_) => {
            send(
                &out,
                json!({"error":"Worker launch/containment failed; review preparation and local launch"}),
            );
        }
        Ok((mut child, tree)) => {
            let pid = child.id();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let input = child.stdin.take().unwrap();
            let worker = Arc::new(Worker {
                name,
                kind,
                pid,
                marker: marker.clone(),
                input: Mutex::new(input),
                tree,
            });
            workers.insert(id.clone(), worker.clone());
            drop(workers);
            state.journal();
            send(&out, json!({"event":"started","pid":pid,"id":id}));
            let output = out.clone();
            let exec = frame["exec"].as_bool().unwrap_or(false);
            let output_thread = std::thread::spawn(move || {
                let mut r = BufReader::new(stdout);
                while let Ok(Some(text)) = line(&mut r) {
                    if exec {
                        send(&output, json!({"event":"stdout","text":text}));
                    } else if let Ok(message) = serde_json::from_str::<Value>(&text) {
                        send(&output, json!({"event":"message","message":message}));
                    } else {
                        send(
                            &output,
                            json!({"event":"error","error":"MCP wrote non-JSON data to stdout"}),
                        );
                        break;
                    }
                }
            });
            let diagnostics = frame["diagnostics"].as_bool().unwrap_or(false);
            let error_output = out.clone();
            std::thread::spawn(move || {
                let mut r = stderr;
                let mut buffer = [0u8; 4096];
                while let Ok(n) = r.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    if diagnostics {
                        send(
                            &error_output,
                            json!({"event":"stderr","text":String::from_utf8_lossy(&buffer[..n])}),
                        );
                    }
                }
            });
            let wait_state = state.clone();
            let wait_id = id.clone();
            let finished = out.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
                wait_state.stop(&wait_id);
                let _ = output_thread.join();
                send(&finished, json!({"event":"exit","code":code}));
            });
            // The worker stream stays open, independently of other sessions/control connections.
            let _ = reader.get_mut().set_read_timeout(None);
            loop {
                let text = match line(&mut reader) {
                    Ok(Some(t)) => t,
                    Ok(None) => break,
                    Err(_) => break,
                };
                let v = match serde_json::from_str::<Value>(&text) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                if v["action"] == "close" {
                    break;
                }
                if let Some(message) = v.get("message") {
                    if writeln!(worker.input.lock().unwrap(), "{}", message).is_err() {
                        break;
                    }
                }
            }
            state.stop(&id);
        }
    }
}
#[cfg(target_os = "macos")]
fn recover(data: &std::path::Path, expected: Option<u32>) {
    let Ok(text) = std::fs::read_to_string(data.join("mcp-workers.json")) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if let Some(pid) = expected {
        if v["supervisor"].as_u64() != Some(pid as u64) {
            return;
        }
    }
    for entry in v["workers"].as_array().into_iter().flatten() {
        if let Some(marker) = entry["marker"].as_str() {
            for pid in process_tree::marked_pids(marker) {
                let identity = process_tree::process_identity(pid);
                if identity.is_some() && process_tree::process_identity(pid) == identity {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            }
        }
    }
}
#[cfg(target_os = "macos")]
fn guard(data: std::path::PathBuf, pid: u32) -> std::io::Result<()> {
    let identity = process_tree::process_identity(pid);
    while identity.is_some() && process_tree::process_identity(pid) == identity {
        std::thread::sleep(Duration::from_millis(500));
    }
    recover(&data, Some(pid));
    Ok(())
}
fn supervisor(data: std::path::PathBuf) -> std::io::Result<()> {
    std::fs::create_dir_all(&data)?;
    let mut input = BufReader::new(std::io::stdin());
    let Some(text) = line(&mut input)? else {
        return Ok(());
    };
    let boot: Value = serde_json::from_str(&text)?;
    let token = boot["token"]
        .as_str()
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or(std::io::ErrorKind::InvalidData)?
        .to_string();
    let paused = std::fs::read_to_string(data.join("mcp-paused.json"))
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| v["paused"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let pool = boot["pool"]
        .as_str()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".agents"));
    #[cfg(target_os = "macos")]
    {
        recover(&data, None);
    }
    let state = Arc::new(State {
        workers: Mutex::new(HashMap::new()),
        paused: Mutex::new(paused),
        data,
        pool,
        token,
    });
    state.journal();
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("--guard")
            .arg(&state.data)
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = command.spawn()?;
    }
    println!(
        "{}",
        json!({"port":listener.local_addr()?.port(),"token":state.token})
    );
    std::io::stdout().flush()?;
    let lifetime = state.clone();
    std::thread::spawn(move || {
        while matches!(line(&mut input), Ok(Some(_))) {}
        let ids: Vec<_> = lifetime.workers.lock().unwrap().keys().cloned().collect();
        for id in ids {
            lifetime.stop(&id);
        }
        std::process::exit(0);
    });
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                let s = state.clone();
                std::thread::spawn(move || serve(socket, s));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(e) => return Err(e),
        }
    }
}
fn relay(pool: std::path::PathBuf, workspace: bool, name: Option<String>) -> std::io::Result<()> {
    let mut runtime: Value =
        serde_json::from_str(&std::fs::read_to_string(pool.join("manager-runtime.json"))?)?;
    let mut connected = None;
    let initial_token = runtime["token"].clone();
    let start_lock = pool.join("manager-start.lock");
    let mut owns_lock = false;
    for attempt in 0..30 {
        if let Ok(text) = std::fs::read_to_string(pool.join("manager-runtime.json")) {
            if let Ok(v) = serde_json::from_str(&text) {
                runtime = v;
            }
        }
        match process_tree::manager_pipe(runtime["pipe"].as_str().unwrap_or("")) {
            Ok(pipe) => {
                if attempt > 0 && runtime["token"] == initial_token {
                    for _ in 0..50 {
                        std::thread::sleep(Duration::from_millis(100));
                        if let Ok(text) = std::fs::read_to_string(pool.join("manager-runtime.json"))
                        {
                            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                                runtime = v;
                                if runtime["token"] != initial_token {
                                    break;
                                }
                            }
                        }
                    }
                }
                connected = Some(pipe);
                break;
            }
            Err(_) => {
                if attempt == 0 {
                    if let Some(app) = runtime["app"].as_str() {
                        if std::fs::metadata(&start_lock)
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.elapsed().ok())
                            .is_some_and(|d| d.as_secs() > 60)
                        {
                            let _ = std::fs::remove_file(&start_lock);
                        }
                        if let Ok(mut lock) = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&start_lock)
                        {
                            let _ = writeln!(lock, "{}", std::process::id());
                            owns_lock = true;
                            let mut cmd = Command::new(app);
                            cmd.arg("--hidden")
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null());
                            #[cfg(windows)]
                            {
                                use std::os::windows::process::CommandExt;
                                cmd.creation_flags(0x08000000);
                            }
                            let _ = cmd.spawn();
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
    if owns_lock {
        let _ = std::fs::remove_file(start_lock);
    }
    let pipe = connected.ok_or(std::io::ErrorKind::ConnectionRefused)?;
    let read = pipe.try_clone()?;
    let token = runtime["token"].clone();
    let client_pid = std::process::id();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(read);
        let mut output = std::io::stdout().lock();
        while let Ok(Some(text)) = line(&mut reader) {
            if output
                .write_all(text.as_bytes())
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
        std::process::exit(0);
    });
    let mut writer = pipe;
    let mut input = BufReader::new(std::io::stdin());
    while let Some(text) = line(&mut input)? {
        let message: Value = serde_json::from_str(&text)?;
        let frame = if workspace {
            json!({"token":token,"workspace":true,"message":message,"clientPid":client_pid})
        } else {
            json!({"token":token,"server":name,"message":message,"clientPid":client_pid})
        };
        writeln!(writer, "{}", frame)?;
    }
    Ok(())
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    #[cfg(target_os = "macos")]
    if let Some(i) = args.iter().position(|a| a == "--guard") {
        if let (Some(data), Some(pid)) = (
            args.get(i + 1),
            args.get(i + 2).and_then(|s| s.parse().ok()),
        ) {
            let _ = guard(data.into(), pid);
            return;
        }
    }
    let result = if let Some(index) = args.iter().position(|a| a == "--supervisor") {
        supervisor(
            args.get(index + 1)
                .map(std::path::PathBuf::from)
                .unwrap_or_default(),
        )
    } else {
        let home =
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
        let pool = std::env::var("AIU_POOL")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from(home).join(".agents"));
        let workspace = args.iter().any(|a| a == "--workspace");
        let name = args
            .iter()
            .position(|a| a == "--relay")
            .and_then(|i| args.get(i + 1))
            .cloned();
        relay(pool, workspace, name)
    };
    if result.is_err() {
        eprintln!("AI Usage native MCP connection failed; open the app and review its MCP status.");
        std::process::exit(1);
    }
}
