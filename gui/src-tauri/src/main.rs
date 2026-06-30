#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// Spawn a command in the given cwd, forwarding each stdout line to the webview as
// a "stdout-line" event and a "proc-exit" event (with the exit code) on completion.
#[tauri::command]
async fn run_process(app: tauri::AppHandle, program: String, args: Vec<String>, cwd: String) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .command(program)
        .args(args)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app.emit("stdout-line", line);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app.emit("proc-exit", payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![run_process])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
