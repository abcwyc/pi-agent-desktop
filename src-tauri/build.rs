fn main() {
    for name in ["desktop-backend.html", "desktop-backend.js"] {
        let source = format!("../public/{name}");
        println!("cargo:rerun-if-changed={source}");
        std::fs::copy(&source, format!("../desktop/frontend/{name}"))
            .expect("failed to stage backend selector");
    }
    tauri_build::build()
}
