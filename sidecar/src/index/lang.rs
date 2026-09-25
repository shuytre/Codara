//! 语言识别：扩展名 → 语言标签（与 tree-sitter grammar 对应）。

pub fn detect(rel_path: &str) -> &'static str {
    let ext = rel_path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" | "pyi" => "python",
        "go" => "go",
        "rs" => "rust",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" | "cxx" => "cpp",
        "java" => "java",
        "cs" => "csharp",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "sql" => "sql",
        "sh" | "bash" => "shell",
        "css" => "css",
        "html" | "htm" => "html",
        _ => "",
    }
}
