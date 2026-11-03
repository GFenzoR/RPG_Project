fn main() {
    // Declaring the app's commands makes them deny-by-default: the webview can only call
    // the ones a capability grants (capabilities/default.json).
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["server_info", "api"]));
    if let Err(e) = tauri_build::try_build(attributes) {
        panic!("tauri build script: {e:#}");
    }
}
