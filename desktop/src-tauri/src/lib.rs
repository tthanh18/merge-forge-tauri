mod placement;
mod session;

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Manager, PhysicalPosition, PhysicalSize, State, Window, WindowEvent};

use placement::{choose_frame, Frame, Screen};
use session::{Boot, Session};

struct AppState {
    session: Mutex<Option<Session>>,
    applied: AtomicBool,
    closing: AtomicBool,
    /// Ignore the creation-size events until the saved frame has been applied.
    placement_ready: AtomicBool,
}

#[tauri::command]
fn boot(app: tauri::AppHandle, state: State<AppState>) -> Boot {
    let launch = session::load_from_env();
    if let session::Launch::Ready(session) = &launch {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_title(&format!("Merge: {}", session.file_path()));
        }
    }
    let boot = launch.boot();
    *state.session.lock().expect("session lock") = launch.into_session();
    boot
}

#[tauri::command]
fn apply_result(
    app: tauri::AppHandle,
    state: State<AppState>,
    content: String,
    eol: String,
) -> Result<(), String> {
    let guard = state.session.lock().expect("session lock");
    let session = guard.as_ref().ok_or("No merge is open.")?;
    session.write_result(&content, &eol)?;
    drop(guard);
    state.applied.store(true, Ordering::SeqCst);
    remember_open(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn abort_merge(app: tauri::AppHandle) {
    remember_open(&app);
    app.exit(1);
}

fn restore_window(window: &tauri::WebviewWindow) {
    let screens = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(screen_of)
        .collect::<Vec<_>>();
    if let Some(saved) = load_frame(&window.app_handle()) {
        let frame = choose_frame(saved, &screens);
        let _ = window.set_position(PhysicalPosition::new(frame.x, frame.y));
        let _ = window.set_size(PhysicalSize::new(frame.width, frame.height));
    }
}

fn remember(window: &Window) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    remember_geometry(&window.app_handle(), position, size);
}

fn remember_open(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    remember_geometry(app, position, size);
}

fn remember_geometry(
    app: &tauri::AppHandle,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    if !app
        .state::<AppState>()
        .placement_ready
        .load(Ordering::SeqCst)
    {
        return;
    }
    if size.width < 200 || size.height < 200 {
        return;
    }
    save_frame(
        app,
        Frame {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    );
}

fn screen_of(monitor: &tauri::Monitor) -> Screen {
    let area = monitor.work_area();
    Screen {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

fn frame_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("window.json"))
}

fn load_frame(app: &tauri::AppHandle) -> Option<Frame> {
    let path = frame_path(app)?;
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn save_frame(app: &tauri::AppHandle, frame: Frame) {
    let Some(path) = frame_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&frame) {
        let _ = fs::write(path, bytes);
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            session: Mutex::new(None),
            applied: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            placement_ready: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![boot, apply_result, abort_merge])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }
            app.state::<AppState>()
                .placement_ready
                .store(true, Ordering::SeqCst);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember(window),
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return;
                }
                remember(window);
                let code = if state.applied.load(Ordering::SeqCst) {
                    0
                } else {
                    1
                };
                api.prevent_close();
                window.app_handle().exit(code);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Merge Forge");
}
