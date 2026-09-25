//! M5 符号提取单测：tree-sitter 主通道 + 启发式回落。
//! 由 index/mod.rs 以 #[cfg(test)] mod parse_test; 挂载。
use super::parse;

#[test]
fn rust_symbols_with_impl_container() {
    let src = r#"
pub struct User { pub name: String }

pub trait Greeter {
    fn greet(&self) -> String;
}

impl Greeter for User {
    fn greet(&self) -> String { format!("hi {}", self.name) }
}

pub fn build_user(label: &str) -> User { User { name: label.to_string() } }
"#;
    let syms = parse::extract(std::path::Path::new("lib.rs"), "rust", src);
    let find = |name: &str| syms.iter().find(|s| s.name == name);
    assert!(find("User").map(|s| s.kind == "struct").unwrap_or(false));
    assert!(find("Greeter").map(|s| s.kind == "trait").unwrap_or(false));
    let greets: Vec<_> = syms.iter().filter(|s| s.name == "greet").collect();
    assert_eq!(greets.len(), 2, "trait 签名 + impl 实现各一个 greet");
    assert!(greets.iter().all(|g| g.kind == "function"));
    // trait 签名：container=Greeter；impl 实现：container=User，行尾落在声明块内
    assert!(greets.iter().any(|g| g.container.as_deref() == Some("Greeter") && g.line_end == g.line_start));
    let _impl_greet = greets.iter().find(|g| g.container.as_deref() == Some("User")).expect("impl greet");
    // 多行声明的行尾 = 声明块末行（trait Greeter 块跨 3 行）
    let trait_greeter = find("Greeter").expect("trait");
    assert!(trait_greeter.line_end > trait_greeter.line_start, "tree-sitter 行尾应为声明块末行");
    assert!(find("build_user").map(|s| s.kind == "function").unwrap_or(false));
}

#[test]
fn typescript_symbols_class_container() {
    let src = r#"export interface Config { retries: number }

export class HttpClient {
    get(url: string) { return url }
    private retry() { return 3 }
}

export function debounce(fn: Function) { return fn }

export type Handler = (e: Event) => void;
"#;
    let syms = parse::extract(std::path::Path::new("util.ts"), "typescript", src);
    let find = |name: &str| syms.iter().find(|s| s.name == name);
    assert!(find("Config").map(|s| s.kind == "interface").unwrap_or(false));
    assert!(find("HttpClient").map(|s| s.kind == "class").unwrap_or(false));
    let get = find("get").expect("method get");
    assert_eq!(get.kind, "method");
    assert_eq!(get.container.as_deref(), Some("HttpClient"));
    assert!(find("debounce").map(|s| s.kind == "function").unwrap_or(false));
    assert!(find("Handler").map(|s| s.kind == "type").unwrap_or(false));
}

#[test]
fn python_symbols_class_container() {
    let src = "class Engine:\n    def start(self):\n        pass\n\ndef main():\n    pass\n";
    let syms = parse::extract(std::path::Path::new("app.py"), "python", src);
    let find = |name: &str| syms.iter().find(|s| s.name == name);
    assert!(find("Engine").map(|s| s.kind == "class").unwrap_or(false));
    let start = find("start").expect("method start");
    assert_eq!(start.container.as_deref(), Some("Engine"));
    assert!(find("main").map(|s| s.kind == "function").unwrap_or(false));
}

#[test]
fn go_symbols_receiver_container() {
    let src = "package main\n\ntype Server struct {\n\tPort int\n}\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n\nfunc main() {}\n";
    let syms = parse::extract(std::path::Path::new("main.go"), "go", src);
    let find = |name: &str| syms.iter().find(|s| s.name == name);
    assert!(find("Server").map(|s| s.kind == "type").unwrap_or(false));
    let start = find("Start").expect("method Start");
    assert_eq!(start.kind, "method");
    assert_eq!(start.container.as_deref(), Some("Server"));
    assert!(find("main").map(|s| s.kind == "function").unwrap_or(false));
}

#[test]
fn unknown_language_falls_back_to_heuristic() {
    // ruby 无 grammar → 启发式回落为空（不崩溃、不误报）
    let src = "class Foo\n  def bar; end\nend\n";
    let syms = parse::extract(std::path::Path::new("f.rb"), "ruby", src);
    assert!(syms.is_empty() || syms.iter().all(|s| !s.name.is_empty()));
}

#[test]
fn tokenizer_camel_and_snake() {
    use super::rank::tokenize;
    assert_eq!(tokenize("parseFileList"), vec!["parse", "file", "list"]);
    assert_eq!(tokenize("user_id"), vec!["user", "id"]);
    assert_eq!(tokenize("XMLHttpRequest"), vec!["xml", "http", "request"]);
    assert_eq!(tokenize("HttpClient.get"), vec!["http", "client", "get"]);
}

#[test]
fn fuzzy_and_bm25() {
    use super::rank::{bm25, fuzzy_eq};
    assert!(fuzzy_eq("greet", "greet"));
    assert!(fuzzy_eq("greet", "greetings")); // 前缀
    assert!(fuzzy_eq("gret", "greet")); // 编辑距离 ≤2
    assert!(!fuzzy_eq("xy", "greet"));
    // BM25：tf 越高分数越高且有界
    let s1 = bm25(1.0, 100.0, 100.0, 100.0, 10.0);
    let s2 = bm25(5.0, 100.0, 100.0, 100.0, 10.0);
    assert!(s2 > s1 && s1 > 0.0);
}





