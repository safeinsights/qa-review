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

#[tauri::command]
async fn git_pull(app: tauri::AppHandle, cwd: String) -> Result<String, String> {
    let output = app
        .shell()
        .command("git")
        .args(["pull"])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// Branch, generate the suite from a trace file, commit, push, and open a PR.
// Each step runs in `cwd` and stops on the first failure.
#[tauri::command]
async fn promote_suite(
    app: tauri::AppHandle,
    cwd: String,
    name: String,
    trace_path: String,
) -> Result<String, String> {
    let branch = format!("qa/{}", name);
    let commit_msg = format!("test: add {} suite (AI-generated, review selectors)", name);

    // Run one command in `cwd`, returning stdout on success or stderr on failure.
    async fn step(
        app: &tauri::AppHandle,
        cwd: &str,
        args: &[&str],
    ) -> Result<String, String> {
        let o = app
            .shell()
            .command(args[0])
            .args(&args[1..])
            .current_dir(cwd.to_string())
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&o.stdout).to_string())
    }

    step(&app, &cwd, &["git", "checkout", "-b", &branch]).await?;
    step(&app, &cwd, &["pnpm", "qatest", "codegen", "--trace", &trace_path]).await?;
    step(&app, &cwd, &["git", "add", "src/suites"]).await?;
    step(&app, &cwd, &["git", "commit", "-m", &commit_msg]).await?;
    step(&app, &cwd, &["git", "push", "-u", "origin", &branch]).await?;
    let pr = step(&app, &cwd, &["gh", "pr", "create", "--fill"]).await?;
    Ok(pr)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![run_process, git_pull, promote_suite])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
