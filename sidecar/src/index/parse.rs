//! 符号提取（M5）：tree-sitter Query 主通道（rust/ts/tsx/js/python/go），
//! 启发式行级解析回落（超纲语言零依赖兜底）。规格 5.2。
//!
//! 设计：capture 命名即 kind（@fn/@struct/@class/@interface/@enum/@type/@method/@module/@const）；
//! kind="container" 为内部标记（impl 目标），不入库只更新容器栈。

#[derive(Debug, Clone)]
pub struct Symbol {
    pub kind: &'static str,
    pub name: String,
    pub line_start: usize,
    pub line_end: usize,
    pub container: Option<String>,
}

pub fn extract(_abs: &std::path::Path, lang: &str, text: &str) -> Vec<Symbol> {
    match lang {
        "rust" => ts_extract(tree_sitter_rust::language(), RUST_QUERY, text, "rust"),
        "typescript" => ts_extract(
            tree_sitter_typescript::language_typescript(),
            TS_QUERY,
            text,
            "typescript",
        ),
        "tsx" => ts_extract(tree_sitter_typescript::language_tsx(), TS_QUERY, text, "typescript"),
        "javascript" => ts_extract(
            tree_sitter_javascript::language(),
            JS_QUERY,
            text,
            "javascript",
        ),
        "python" => ts_extract(tree_sitter_python::language(), PY_QUERY, text, "python"),
        "go" => ts_extract(tree_sitter_go::language(), GO_QUERY, text, "go"),
        _ => heuristic_extract(lang, text),
    }
}

// ---------------- tree-sitter 主通道 ----------------

pub(crate) const RUST_QUERY: &str = "
(function_item name: (identifier) @fn)
(function_signature_item name: (identifier) @fn)
(struct_item name: (type_identifier) @struct)
(enum_item name: (type_identifier) @enum)
(trait_item name: (type_identifier) @trait)
(mod_item name: (identifier) @module)
(type_item name: (type_identifier) @type)
(const_item name: (identifier) @const)
";

pub(crate) const TS_QUERY: &str = "
(function_declaration name: (_) @fn)
(generator_function_declaration name: (_) @fn)
(class_declaration name: (_) @class)
(abstract_class_declaration name: (_) @class)
(interface_declaration name: (_) @interface)
(enum_declaration name: (_) @enum)
(type_alias_declaration name: (_) @type)
(method_definition name: (_) @method)
";

pub(crate) const JS_QUERY: &str = "
(function_declaration name: (_) @fn)
(generator_function_declaration name: (_) @fn)
(class_declaration name: (_) @class)
(method_definition name: (_) @method)
";

pub(crate) const PY_QUERY: &str = "
(function_definition name: (_) @fn)
(class_definition name: (_) @class)
";

pub(crate) const GO_QUERY: &str = "
(function_declaration name: (_) @fn)
(method_declaration name: (_) @method)
(type_declaration (type_spec name: (_) @type))
";

fn kind_of(capture_name: &str) -> &'static str {
    match capture_name {
        "fn" => "function",
        "method" => "method",
        "struct" => "struct",
        "enum" => "enum",
        "trait" => "trait",
        "interface" => "interface",
        "class" => "class",
        "type" => "type",
        "module" => "module",
        "const" => "const",
        _ => "definition",
    }
}

fn ts_extract(lang_fn: tree_sitter::Language, query_src: &str, text: &str, lang: &str) -> Vec<Symbol> {
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang_fn).is_err() {
        return heuristic_extract(lang, text);
    }
    let tree = match parser.parse(text, None) {
        Some(t) => t,
        None => return heuristic_extract(lang, text),
    };
    let query = match tree_sitter::Query::new(&lang_fn, query_src) {
        Ok(q) => q,
        Err(_) => return heuristic_extract(lang, text),
    };
    let mut cursor = tree_sitter::QueryCursor::new();
    let mut out = Vec::new();
    for m in cursor.matches(&query, tree.root_node(), text.as_bytes()) {
        for cap in m.captures {
            let kind = kind_of(query.capture_names()[cap.index as usize]);
            let name = cap.node.utf8_text(text.as_bytes()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let decl_root = declaration_root(cap.node);
            let line_start = cap.node.start_position().row + 1;
            let line_end = decl_root.end_position().row + 1;
            let container = container_for(decl_root, lang, text);
            out.push(Symbol {
                kind,
                name,
                line_start,
                line_end,
                container,
            });
        }
    }
    out.sort_by_key(|s| s.line_start);
    out.dedup_by(|a, b| a.kind == b.kind && a.name == b.name && a.line_start == b.line_start);
    out
}

/// 名称节点 → 所在声明根节点（行尾取该节点）
fn declaration_root(node: tree_sitter::Node) -> tree_sitter::Node {
    let mut cur = node;
    loop {
        let k = cur.kind();
        let is_root = matches!(
            k,
            "function_item"
                | "function_signature_item"
                | "struct_item"
                | "enum_item"
                | "trait_item"
                | "mod_item"
                | "type_item"
                | "const_item"
                | "impl_item"
                | "function_declaration"
                | "generator_function_declaration"
                | "class_declaration"
                | "abstract_class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "type_alias_declaration"
                | "method_definition"
                | "function_definition"
                | "class_definition"
                | "method_declaration"
                | "type_spec"
        );
        if is_root {
            return cur;
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return cur,
        }
    }
}

/// 容器解析：最近的外层 class / impl / receiver
fn container_for(decl: tree_sitter::Node, lang: &str, text: &str) -> Option<String> {
    // go 的 receiver 挂在 method_declaration 自身 → 从自身起查；其余语言从父起查
    let mut cur = if lang == "go" { Some(decl) } else { decl.parent() };
    while let Some(p) = cur {
        match lang {
            "rust" => {
                if p.kind() == "impl_item" {
                    if let Some(ty) = p.child_by_field_name("type") {
                        return Some(ty.utf8_text(text.as_bytes()).ok()?.to_string());
                    }
                }
                if p.kind() == "trait_item" {
                    if let Some(n) = p.child_by_field_name("name") {
                        return Some(n.utf8_text(text.as_bytes()).ok()?.to_string());
                    }
                }
            }
            "typescript" | "javascript" => {
                if matches!(p.kind(), "class_declaration" | "abstract_class_declaration") {
                    if let Some(n) = p.child_by_field_name("name") {
                        return Some(n.utf8_text(text.as_bytes()).ok()?.to_string());
                    }
                }
            }
            "python" => {
                if p.kind() == "class_definition" {
                    if let Some(n) = p.child_by_field_name("name") {
                        return Some(n.utf8_text(text.as_bytes()).ok()?.to_string());
                    }
                }
            }
            "go" => {
                if p.kind() == "method_declaration" {
                    if let Some(recv) = p.child_by_field_name("receiver") {
                        let raw = recv.utf8_text(text.as_bytes()).ok()?;
                        // "(r *HttpClient)" / "(c Client)" → 取最后一个标识符
                        let cleaned: String = raw
                            .chars()
                            .map(|c| if c.is_alphanumeric() || c == '_' { c } else { ' ' })
                            .collect();
                        return cleaned
                            .split_whitespace()
                            .next_back()
                            .map(|s| s.to_string());
                    }
                }
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

// ---------------- 启发式回落（超纲语言） ----------------

pub fn heuristic_extract(lang: &str, text: &str) -> Vec<Symbol> {
    let mut out = Vec::new();
    let mut container: Option<String> = None;
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_start();
        let ln = i + 1;
        let sym = match lang {
            "rust" => parse_rust_line(line),
            "python" => parse_python_line(line),
            "typescript" | "tsx" | "javascript" => parse_ts_line(line),
            "go" => parse_go_line(line),
            _ => None,
        };
        match sym {
            Some((kind, name)) => {
                if kind == "container" {
                    // 内部标记（如 impl 目标）：只更新容器栈，不入库
                    container = Some(name);
                } else {
                    // 类型容器（class/struct/trait/interface）本身入库（container=父容器），
                    // 并成为后续符号的 container
                    if matches!(kind, "class" | "struct" | "trait" | "interface") {
                        let parent = container.clone();
                        container = Some(name.clone());
                        out.push(Symbol {
                            kind,
                            name,
                            line_start: ln,
                            line_end: ln,
                            container: parent,
                        });
                    } else {
                        out.push(Symbol {
                            kind,
                            name,
                            line_start: ln,
                            line_end: ln,
                            container: container.clone(),
                        });
                    }
                }
            }
            None => continue,
        }
    }
    out
}

fn take_ident(s: &str) -> String {
    s.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect()
}

fn parse_rust_line(line: &str) -> Option<(&'static str, String)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("fn ").or_else(|| line.strip_prefix("pub fn ").or_else(|| line.strip_prefix("pub async fn ").or_else(|| line.strip_prefix("async fn ")))) {
        let name = take_ident(rest.trim_start());
        if !name.is_empty() {
            return Some(("function", name));
        }
    }
    for (kw, kind) in [("struct ", "struct"), ("enum ", "enum"), ("trait ", "trait"), ("mod ", "module")] {
        if let Some(rest) = line.strip_prefix(kw).or_else(|| line.strip_prefix(&format!("pub {}", kw))) {
            let name = take_ident(rest.trim_start());
            if !name.is_empty() && name.chars().next().map(|c| c.is_uppercase()).unwrap_or(kind == "module") {
                return Some((kind, name));
            }
        }
    }
    if line.starts_with("impl ") {
        // impl Foo / impl Trait for Foo → 容器取类型名（末段）
        let ty = line
            .strip_prefix("impl ")
            .unwrap_or("")
            .trim_end_matches('{')
            .rsplit(" for ")
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !ty.is_empty() {
            return Some(("container", ty));
        }
    }
    None
}

fn parse_python_line(line: &str) -> Option<(&'static str, String)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("def ").or_else(|| line.strip_prefix("async def ")) {
        let name = take_ident(rest.trim_start());
        if !name.is_empty() {
            return Some(("function", name));
        }
    }
    if let Some(rest) = line.strip_prefix("class ") {
        let name = take_ident(rest.trim_start());
        if !name.is_empty() {
            return Some(("class", name));
        }
    }
    None
}

fn parse_ts_line(line: &str) -> Option<(&'static str, String)> {
    let line = line.trim();
    let line = line
        .strip_prefix("export default ")
        .or_else(|| line.strip_prefix("export "))
        .or_else(|| line.strip_prefix("declare "))
        .unwrap_or(line);
    if let Some(rest) = line.strip_prefix("function ").or_else(|| line.strip_prefix("async function ")) {
        let name = take_ident(rest.trim_start());
        if !name.is_empty() {
            return Some(("function", name));
        }
    }
    for (kw, kind) in [("class ", "class"), ("interface ", "interface"), ("enum ", "enum"), ("namespace ", "container")] {
        if let Some(rest) = line.strip_prefix(kw) {
            let name = take_ident(rest.trim_start());
            if !name.is_empty() {
                return Some((kind, name));
            }
        }
    }
    if let Some(rest) = line.strip_prefix("type ") {
        let name = take_ident(rest.trim_start());
        if !name.is_empty() {
            return Some(("type", name));
        }
    }
    None
}

fn parse_go_line(line: &str) -> Option<(&'static str, String)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("func ") {
        let rest = rest.trim_start();
        if rest.starts_with('(') {
            // method: func (r Recv) Name(
            if let Some(close) = rest.find(')') {
                let after = rest[close + 1..].trim_start();
                let name = take_ident(after);
                if !name.is_empty() {
                    return Some(("method", name));
                }
            }
        } else {
            let name = take_ident(rest);
            if !name.is_empty() {
                return Some(("function", name));
            }
        }
    }
    if let Some(rest) = line.strip_prefix("type ") {
        let name = take_ident(rest.trim_start());
        let tail = rest.trim_start().strip_prefix(&name).unwrap_or("");
        if !name.is_empty() && (tail.trim_start().starts_with("struct") || tail.trim_start().starts_with("interface")) {
            return Some(("struct", name));
        }
    }
    None
}
