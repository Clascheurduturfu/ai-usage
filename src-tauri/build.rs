fn main() {
    println!("cargo:rerun-if-env-changed=AIU_BUILD_MCP");
    if std::env::var("AIU_BUILD_MCP").as_deref() == Ok("1") { return; }
    tauri_build::build()
}
