use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const SANDBOX_VERSION: &str = "1";
const RUNTIME_ADDRESS: &str = "127.0.0.1:18765";
const QWEN_TTS_ADDRESS: &str = "127.0.0.1:18002";
const STUDIO_URL: &str = "http://127.0.0.1:18765/#studio";
const UI_SCALE: f64 = 0.8;

#[derive(Clone)]
struct SandboxPaths {
    root: PathBuf,
    runtime: PathBuf,
    engine: PathBuf,
    qwen_runtime: PathBuf,
    projects: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    logs: PathBuf,
    marker: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MagicSetupStatus {
    state: String,
    step: String,
    step_label: String,
    message: String,
    progress: u8,
    first_run: bool,
    error: String,
    sandbox_path: String,
}

#[derive(Clone)]
struct MagicSetupState(Arc<Mutex<MagicSetupStatus>>);

#[derive(Clone, Default)]
struct ProcessState {
    runtime: Arc<Mutex<Option<Child>>>,
    qwen_tts: Arc<Mutex<Option<Child>>>,
}

fn port_ready(address: &str) -> bool {
    let Ok(address) = address.parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn qwen_service_ready() -> bool {
    let Ok(address) = QWEN_TTS_ADDRESS.parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let response = String::from_utf8_lossy(&response);
    response.contains("200 OK")
        && (response.contains("\"ready\":true") || response.contains("\"ready\": true"))
}

fn runtime_service_probe() -> (bool, Option<String>, bool) {
    let Ok(address) = RUNTIME_ADDRESS.parse::<SocketAddr>() else {
        return (false, None, false);
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return (false, None, false);
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if stream
        .write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return (false, None, false);
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let response = String::from_utf8_lossy(&response);
    let healthy = response.contains("200 OK")
        && (response.contains("\"status\":\"healthy\"")
            || response.contains("\"status\": \"healthy\""));
    let build_id = response
        .split("\"runtimeBuildId\":\"")
        .nth(1)
        .and_then(|value| value.split('"').next())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let is_idol_runtime = response.contains("\"service\":\"ai-idol-runtime\"")
        || (response.contains("\"currentVisual\"") && response.contains("\"queueSize\""));
    (healthy, build_id, is_idol_runtime)
}

fn runtime_build_id(backend: &Path) -> Result<String, String> {
    let bytes = fs::read(backend).map_err(|error| error.to_string())?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

#[cfg(unix)]
fn terminate_runtime_port_owner() -> Result<(), String> {
    let output = Command::new("lsof")
        .args(["-nP", "-tiTCP:18765", "-sTCP:LISTEN"])
        .output()
        .map_err(|error| error.to_string())?;
    let current_pid = std::process::id();
    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| *pid != current_pid)
        .collect();
    if pids.is_empty() {
        return Err("Could not identify the previous AI runtime process".into());
    }
    for pid in pids {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
    for _ in 0..50 {
        if !port_ready(RUNTIME_ADDRESS) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("The previous AI runtime did not release port 18765".into())
}

#[cfg(target_os = "windows")]
fn terminate_runtime_port_owner() -> Result<(), String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| error.to_string())?;
    let pids: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains("127.0.0.1:18765") && line.contains("LISTENING"))
        .filter_map(|line| line.split_whitespace().last().map(str::to_owned))
        .collect();
    if pids.is_empty() {
        return Err("Could not identify the previous AI runtime process".into());
    }
    for pid in pids {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .status();
    }
    for _ in 0..50 {
        if !port_ready(RUNTIME_ADDRESS) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("The previous AI runtime did not release port 18765".into())
}

fn source_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live inside the workspace")
        .to_path_buf()
}

fn sandbox_paths(app: &AppHandle) -> Result<SandboxPaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let root = app_data.join("sandbox-v1");
    Ok(SandboxPaths {
        runtime: root.join("runtime"),
        engine: root.join("engine"),
        qwen_runtime: root.join("engines/qwen-tts"),
        projects: root.join("projects"),
        data: root.join("data"),
        cache: root.join("cache"),
        logs: root.join("logs"),
        marker: root.join(".setup-complete.json"),
        root,
    })
}

fn update_setup(
    state: &MagicSetupState,
    step: &str,
    step_label: &str,
    message: &str,
    progress: u8,
) {
    let mut status = state.0.lock().expect("magic setup state");
    status.state = "RUNNING".into();
    status.step = step.into();
    status.step_label = step_label.into();
    status.message = message.into();
    status.progress = progress;
    status.error.clear();
}

fn fail_setup(state: &MagicSetupState, error: impl Into<String>) {
    let mut status = state.0.lock().expect("magic setup state");
    status.state = "ERROR".into();
    status.error = error.into();
}

fn copy_tree_fallback(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_tree_fallback(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("Could not copy {}: {error}", source_path.display()))?;
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, target: &Path, replace: bool) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if replace && target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let copied = Command::new("cp")
            .arg("-cR")
            .arg(source.join("."))
            .arg(target)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if copied {
            return Ok(());
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let copied = Command::new("cp")
            .arg("-a")
            .arg("--reflink=auto")
            .arg(source.join("."))
            .arg(target)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if copied {
            return Ok(());
        }
    }
    copy_tree_fallback(source, target)
}

fn copy_file_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() || !source.is_file() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, target).map_err(|error| error.to_string())?;
    Ok(())
}

fn run_setup_script(script: &Path, environment: &[(&str, &Path)]) -> Result<(), String> {
    if !script.is_file() {
        return Err(format!("Setup script is missing: {}", script.display()));
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new("bash");
    command.arg(script);
    #[cfg(target_os = "windows")]
    command.arg(script);
    for (key, value) in environment {
        command.env(key, value);
    }
    let status = command.status().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("Dependency installer exited with {status}"));
    }
    Ok(())
}

fn platform_setup_script(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return root.join("setup_windows.ps1");
    }
    #[cfg(not(target_os = "windows"))]
    {
        root.join("setup_macos.sh")
    }
}

fn perform_magic_setup(app: &AppHandle, state: &MagicSetupState) -> Result<SandboxPaths, String> {
    let paths = sandbox_paths(app)?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let bundled = resource_dir.join("desktop-runtime");
    let workspace = source_workspace_root();
    let first_run = !paths.marker.is_file();
    state.0.lock().expect("magic setup state").first_run = first_run;

    update_setup(
        state,
        "sandbox",
        "Creating private sandbox",
        "Separating app data from development files and other sessions.",
        5,
    );
    for directory in [
        &paths.root,
        &paths.runtime,
        &paths.engine,
        &paths.qwen_runtime,
        &paths.projects,
        &paths.data,
        &paths.cache,
        &paths.logs,
    ] {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }

    update_setup(
        state,
        "runtime",
        "Installing native runtime",
        "Synchronizing the local server and operator interface.",
        18,
    );
    for name in ["backend", "operator-dashboard", "bin"] {
        copy_tree(&bundled.join(name), &paths.runtime.join(name), true)?;
    }
    copy_tree(&bundled.join("engine"), &paths.engine, false)?;

    update_setup(
        state,
        "sandbox",
        "Migrating studio data",
        "Bringing existing projects and settings into the private sandbox.",
        30,
    );
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    copy_file_if_missing(
        &app_data.join("runtime-data/runtime.sqlite"),
        &paths.data.join("runtime.sqlite"),
    )?;
    copy_tree(&app_data.join("local-projects"), &paths.projects, false)?;
    copy_tree(&workspace.join("local-projects"), &paths.projects, false)?;

    let live_root = paths.engine.join("services/talking-head/livetalking");
    let live_seed = workspace.join("services/talking-head/livetalking");
    update_setup(
        state,
        "python",
        "Preparing Python environments",
        "Installing isolated Python runtimes for voice and realtime avatar inference.",
        44,
    );
    if !live_root.join(".venv/bin/python").is_file()
        && !live_root.join(".venv/Scripts/python.exe").is_file()
    {
        copy_tree(&live_seed.join(".venv"), &live_root.join(".venv"), false)?;
    }
    if !paths.qwen_runtime.join(".venv/bin/python").is_file()
        && !paths
            .qwen_runtime
            .join(".venv/Scripts/python.exe")
            .is_file()
    {
        copy_tree(
            &workspace.join("runtime-data/qwen-tts/.venv"),
            &paths.qwen_runtime.join(".venv"),
            false,
        )?;
    }

    update_setup(
        state,
        "models",
        "Installing AI models",
        "Verifying Qwen TTS and Live Avatar model assets.",
        62,
    );
    if !live_root.join("models/musetalkV15/unet.pth").is_file() {
        copy_tree(&live_seed.join("models"), &live_root.join("models"), false)?;
    }
    let qwen_model = paths.qwen_runtime.join("gwen-tts-0.6B-8bit");
    if !qwen_model.join("config.json").is_file() {
        copy_tree(
            &workspace.join("runtime-data/qwen-tts/gwen-tts-0.6B-8bit"),
            &qwen_model,
            false,
        )?;
    }
    copy_tree(
        &app_data.join("qwen-tts/data"),
        &paths.qwen_runtime.join("data"),
        false,
    )?;

    let live_python_ready = live_root.join(".venv/bin/python").is_file()
        || live_root.join(".venv/Scripts/python.exe").is_file();
    if !live_python_ready || !live_root.join("models/musetalkV15/unet.pth").is_file() {
        update_setup(
            state,
            "models",
            "Downloading Live Avatar engine",
            "This one-time download may take several minutes.",
            68,
        );
        run_setup_script(&platform_setup_script(&live_root), &[])?;
    }
    let qwen_python_ready = paths.qwen_runtime.join(".venv/bin/python").is_file()
        || paths
            .qwen_runtime
            .join(".venv/Scripts/python.exe")
            .is_file();
    if !qwen_python_ready || !qwen_model.join("config.json").is_file() {
        update_setup(
            state,
            "models",
            "Downloading Vietnamese voice model",
            "Installing the fast local Qwen TTS model.",
            76,
        );
        let qwen_service_root = paths.engine.join("services/qwen-tts");
        run_setup_script(
            &platform_setup_script(&qwen_service_root),
            &[("QWEN_TTS_RUNTIME_DIR", &paths.qwen_runtime)],
        )?;
    }

    update_setup(
        state,
        "warmup",
        "Finalizing the sandbox",
        "Checking model files and preparing engine caches.",
        86,
    );
    for required in [
        paths.runtime.join("backend/dist/index.js"),
        paths.runtime.join("operator-dashboard/index.html"),
        live_root.join("models/musetalkV15/unet.pth"),
        qwen_model.join("config.json"),
    ] {
        if !required.exists() {
            return Err(format!(
                "Required sandbox asset is missing: {}",
                required.display()
            ));
        }
    }
    fs::write(
        &paths.marker,
        serde_json::json!({ "version": SANDBOX_VERSION, "ready": true, "root": paths.root })
            .to_string(),
    )
    .map_err(|error| error.to_string())?;
    Ok(paths)
}

fn first_existing_file(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn start_qwen_tts(paths: &SandboxPaths) -> Result<Option<Child>, String> {
    if port_ready(QWEN_TTS_ADDRESS) {
        if qwen_service_ready() {
            // A previous native session may have left a healthy Qwen worker
            // alive. Reuse it instead of creating a second listener.
            return Ok(None);
        }
        return Err(format!(
            "Qwen TTS port is occupied by a service that is not healthy: {QWEN_TTS_ADDRESS}"
        ));
    }
    let service = paths.engine.join("services/qwen-tts/server.py");
    let python = first_existing_file([
        paths.qwen_runtime.join(".venv/bin/python"),
        paths.qwen_runtime.join(".venv/Scripts/python.exe"),
    ])
    .ok_or("Qwen TTS Python environment is missing")?;
    let model = paths.qwen_runtime.join("gwen-tts-0.6B-8bit");
    let mut child = Command::new(python)
        .arg(service)
        .arg("--model")
        .arg(model)
        .arg("--data-dir")
        .arg(paths.qwen_runtime.join("data"))
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("18002")
        .env("PYTHONUNBUFFERED", "1")
        .env("HF_HOME", paths.cache.join("huggingface"))
        .env("XDG_CACHE_HOME", &paths.cache)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Qwen TTS: {error}"))?;
    for _ in 0..480 {
        if qwen_service_ready() {
            return Ok(Some(child));
        }
        thread::sleep(Duration::from_millis(250));
    }
    stop_process(&mut child);
    Err("Qwen TTS did not become ready within 120 seconds".into())
}

fn start_runtime(paths: &SandboxPaths) -> Result<Option<Child>, String> {
    let backend = paths.runtime.join("backend/dist/index.js");
    let build_id = runtime_build_id(&backend)?;
    if port_ready(RUNTIME_ADDRESS) {
        let (healthy, running_build_id, is_idol_runtime) = runtime_service_probe();
        if healthy && running_build_id.as_deref() == Some(build_id.as_str()) {
            // Reuse a healthy runtime left by an earlier native session.
            return Ok(None);
        }
        if healthy && is_idol_runtime {
            terminate_runtime_port_owner()?;
        } else {
            return Err(format!(
                "Runtime port is occupied by another service: {RUNTIME_ADDRESS}"
            ));
        }
    }
    let dashboard = paths.runtime.join("operator-dashboard");
    #[cfg(target_os = "windows")]
    let node = paths.runtime.join("bin/node.exe");
    #[cfg(not(target_os = "windows"))]
    let node = paths.runtime.join("bin/node");
    let mut child = Command::new(node)
        .arg("--env-file-if-exists=.env")
        .arg(backend)
        .current_dir(&paths.root)
        .env("AI_IDOL_DESKTOP", "1")
        .env("AI_IDOL_RUNTIME_BUILD_ID", &build_id)
        .env("AI_IDOL_SANDBOX_ROOT", &paths.root)
        .env("AI_IDOL_ENGINE_ROOT", &paths.engine)
        .env("AI_IDOL_PROJECTS_ROOT", &paths.projects)
        .env("AI_IDOL_DASHBOARD_DIR", dashboard)
        .env("RUNTIME_DB_PATH", paths.data.join("runtime.sqlite"))
        .env("PORT", "18765")
        .env(
            "CORS_ALLOWED_ORIGINS",
            "http://127.0.0.1:18765,http://localhost:18765",
        )
        .env("QWEN_TTS_ENDPOINT", "http://127.0.0.1:18002")
        .env("LIVETALKING_ENDPOINT", "http://127.0.0.1:18011")
        .env("LIVETALKING_PORT", "18011")
        .env("HF_HOME", paths.cache.join("huggingface"))
        .env("TORCH_HOME", paths.cache.join("torch"))
        .env("XDG_CACHE_HOME", &paths.cache)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start AI runtime: {error}"))?;
    for _ in 0..480 {
        if port_ready(RUNTIME_ADDRESS) {
            return Ok(Some(child));
        }
        thread::sleep(Duration::from_millis(250));
    }
    stop_process(&mut child);
    Err("AI runtime did not become ready within 120 seconds".into())
}

fn stop_process(child: &mut Child) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T"])
        .status();
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let _ = child.wait();
}

fn launch_magic_setup(app: AppHandle, setup: MagicSetupState, processes: ProcessState) {
    {
        let mut status = setup.0.lock().expect("magic setup state");
        if status.state == "RUNNING" {
            return;
        }
        status.state = "RUNNING".into();
        status.error.clear();
    }
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let paths = perform_magic_setup(&app, &setup)?;
            update_setup(
                &setup,
                "warmup",
                "Warming Vietnamese voice",
                "Loading Qwen TTS into the private runtime.",
                91,
            );
            let qwen = start_qwen_tts(&paths)?;
            *processes.qwen_tts.lock().expect("Qwen process lock") = qwen;
            update_setup(
                &setup,
                "warmup",
                "Starting Live Studio",
                "Launching the native runtime and realtime avatar worker.",
                96,
            );
            let runtime = start_runtime(&paths)?;
            *processes.runtime.lock().expect("runtime process lock") = runtime;
            let mut status = setup.0.lock().expect("magic setup state");
            status.state = "READY".into();
            status.progress = 100;
            status.step = "warmup".into();
            status.step_label = "Studio ready".into();
            status.message = "All engines are running inside the private sandbox.".into();
            drop(status);
            let studio_url = STUDIO_URL
                .parse()
                .map_err(|error| format!("Invalid studio URL: {error}"))?;
            let studio_window =
                WebviewWindowBuilder::new(&app, "studio", WebviewUrl::External(studio_url))
                    .title("AI IDOL STREAMER")
                    .initialization_script(
                        "document.documentElement.classList.add('native-ui-scale');",
                    )
                    .inner_size(1480.0, 920.0)
                    .min_inner_size(960.0, 640.0);
            #[cfg(target_os = "macos")]
            let studio_window = studio_window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let studio_window = studio_window.build().map_err(|error| error.to_string())?;
            studio_window
                .set_zoom(UI_SCALE)
                .map_err(|error| error.to_string())?;
            if let Some(window) = app.get_webview_window("main") {
                window.close().map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            fail_setup(&setup, error);
        }
    });
}

#[tauri::command]
fn magic_setup_status(state: State<'_, MagicSetupState>) -> MagicSetupStatus {
    state.0.lock().expect("magic setup state").clone()
}

#[tauri::command]
fn retry_magic_setup(
    app: AppHandle,
    state: State<'_, MagicSetupState>,
    processes: State<'_, ProcessState>,
) -> Result<(), String> {
    if state.0.lock().expect("magic setup state").state != "ERROR" {
        return Ok(());
    }
    launch_magic_setup(app, state.inner().clone(), processes.inner().clone());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let setup = MagicSetupState(Arc::new(Mutex::new(MagicSetupStatus {
        state: "PENDING".into(),
        step: "sandbox".into(),
        step_label: "Creating sandbox".into(),
        message: "Preparing the isolated AI workspace.".into(),
        progress: 0,
        first_run: true,
        error: String::new(),
        sandbox_path: String::new(),
    })));
    let processes = ProcessState::default();
    let setup_for_app = setup.clone();
    let processes_for_app = processes.clone();
    let processes_for_window = processes.clone();
    let processes_for_exit = processes.clone();

    let app = tauri::Builder::default()
        .manage(setup)
        .manage(processes)
        .invoke_handler(tauri::generate_handler![
            magic_setup_status,
            retry_magic_setup
        ])
        .setup(move |app| {
            let paths = sandbox_paths(app.handle()).map_err(std::io::Error::other)?;
            setup_for_app
                .0
                .lock()
                .expect("magic setup state")
                .sandbox_path = paths.root.display().to_string();
            let setup_window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("setup.html".into()))
                    .title("AI IDOL STREAMER")
                    .inner_size(1480.0, 920.0)
                    .min_inner_size(960.0, 640.0);
            #[cfg(target_os = "macos")]
            let setup_window = setup_window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let setup_window = setup_window.build()?;
            setup_window.set_zoom(UI_SCALE)?;
            launch_magic_setup(
                app.handle().clone(),
                setup_for_app.clone(),
                processes_for_app.clone(),
            );
            Ok(())
        })
        .on_window_event(move |window, event| {
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            let studio_closed = window.label() == "studio";
            let setup_closed_without_studio = window.label() == "main"
                && window.app_handle().get_webview_window("studio").is_none();
            if !studio_closed && !setup_closed_without_studio {
                return;
            }
            if let Some(mut child) = processes_for_window
                .runtime
                .lock()
                .expect("runtime lock")
                .take()
            {
                stop_process(&mut child);
            }
            if let Some(mut child) = processes_for_window
                .qwen_tts
                .lock()
                .expect("Qwen lock")
                .take()
            {
                stop_process(&mut child);
            }
            window.app_handle().exit(0);
        })
        .build(tauri::generate_context!())
        .expect("error while building AI IDOL STREAMER");

    app.run(move |_app_handle, event| {
        if !matches!(event, RunEvent::Exit) {
            return;
        }
        if let Some(mut child) = processes_for_exit
            .runtime
            .lock()
            .expect("runtime lock")
            .take()
        {
            stop_process(&mut child);
        }
        if let Some(mut child) = processes_for_exit
            .qwen_tts
            .lock()
            .expect("Qwen lock")
            .take()
        {
            stop_process(&mut child);
        }
    });
}
