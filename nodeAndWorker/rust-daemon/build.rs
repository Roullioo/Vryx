use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn daemon_commit() -> String {
    if let Ok(value) = std::env::var("VRYX_DAEMON_COMMIT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(value) = std::env::var("GITHUB_SHA") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(12).collect();
        }
    }
    let mut commit =
        git_output(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let dirty = Command::new("git")
        .args(["diff", "--quiet", "--ignore-submodules", "--"])
        .status()
        .map(|status| !status.success())
        .unwrap_or(false);
    if dirty && commit != "unknown" {
        commit.push_str("-dirty");
    }
    commit
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-env-changed=VRYX_DAEMON_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rustc-env=VRYX_DAEMON_GIT_COMMIT={}", daemon_commit());

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile(&["../proto/vryx.proto"], &["../proto"])?;
    Ok(())
}
