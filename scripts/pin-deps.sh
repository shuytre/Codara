#!/bin/bash
# 生成 Cargo.lock 并把依赖降级到 Rust 1.77.2 可编译的版本（2024-04 时期）
# 用法：bash scripts/pin-deps.sh
set -e
M=/workspace/codara/sidecar/Cargo.toml

echo "== 1. resolve with modern cargo"
cargo check --manifest-path $M --offline 2>/dev/null || cargo check --manifest-path $M

echo "== 2. downgrade edition2024-era crates"
pin() {
  cargo update --manifest-path $M -p "$1" --precise "$2" 2>&1 | grep -E "(Downgrading|error)" || true
}

pin bstr@1.13.1 1.9.1
pin once_cell@1.21.4 1.19.0
pin quote@1.0.47 1.0.36
pin proc-macro2 1.0.79
pin unicode-ident 1.0.12
pin syn@2.0.106 2.0.58
pin crossbeam-utils@0.8.23 0.8.19
pin crossbeam-channel 0.5.12
pin crossbeam-deque@0.8.8 0.8.5
pin crossbeam-epoch@0.9.21 0.9.18
pin ahash@0.8.12 0.8.11
pin hashbrown@0.14.5 0.14.3
pin regex-syntax@0.8.11 0.8.3
pin regex-automata 0.4.6
pin regex 1.10.4
pin bitflags@2.13.2 2.5.0
pin cc@1.4.7 1.0.90
pin libc 0.2.153
pin memchr 2.7.2
pin log 0.4.21
pin walkdir 2.5.0
pin globset 0.4.14
pin grep-matcher 0.1.7
pin grep-searcher 0.1.12
pin grep-regex 0.1.12
pin ignore 0.4.21
pin encoding_rs_io 0.1.7
pin ryu 1.0.17
pin itoa 1.0.11
pin serde 1.0.197
pin serde_derive 1.0.197
pin serde_json 1.0.115
pin libsqlite3-sys 0.28.0
pin hashlink 0.9.0
pin fallible-iterator 0.3.0
pin fallible-streaming-iterator 0.1.9
pin smallvec 1.13.2
pin rustversion 1.0.14
pin windows-core 0.54.0
pin windows-targets 0.52.5
pin windows-sys 0.52.0
pin windows-link 0.1.1
pin utf8parse 0.2.1
pin same-file 1.0.6
pin pkg-config 0.3.30
pin vcpkg 0.2.15
pin sha1_smol 1.0.0
pin zero 1.0.0
pin generic-array 0.14.7
pin block-buffer 0.10.4
pin crypto-common 0.1.6
pin cpufeatures 0.2.12
pin digest 0.10.7
pin cfg-if 1.0.0
pin equivalent 1.0.1
pin allocator-api2 0.2.18
pin version_check 0.9.4
pin typenum 1.17.0
pin num-traits 0.2.18
pin byteorder 1.5.0
pin bumpalo 3.15.4
pin wasi 0.11.0
pin js-sys 0.3.69
pin wasm-bindgen 0.2.92
pin byte-slice-cast 1.2.2
pin encoding-index-simplified 2.0.0
pin encoding-index-korean 2.0.0
pin encoding-index-japanese 2.0.0
pin encoding-index-singlebyte 2.0.0
pin encoding-index-tradchinese 2.0.0
pin encoding 0.2.33
pin encoding_rs 0.8.34
pin getrandom 0.2.12
pin zerocopy 0.7.32
pin lock_api 0.4.11
pin parking_lot 0.12.1
pin parking_lot_core 0.9.9
pin scopeguard 1.2.0

echo "== 3. done; now run 1.77.2 cargo check"
