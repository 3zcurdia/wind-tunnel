#!/usr/bin/env bash
# Vercel build: install Rust toolchain + wasm-pack, build the wasm crate
# (src/wasm/ is gitignored, so bindings must be generated at deploy time),
# then run the Next.js production build.
set -euo pipefail

# Vercel persists node_modules between builds, so park the Rust toolchain
# and cargo caches there to avoid re-downloading/recompiling every deploy.
export CARGO_HOME="${PWD}/node_modules/.cache/cargo-home"
export RUSTUP_HOME="${PWD}/node_modules/.cache/rustup-home"
export CARGO_TARGET_DIR="${PWD}/node_modules/.cache/cargo-target"
export PATH="${CARGO_HOME}/bin:${HOME}/.cargo/bin:${PATH}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust toolchain..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable \
        --target wasm32-unknown-unknown --no-modify-path
fi
rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "Installing wasm-pack..."
  curl --proto '=https' --tlsv1.2 -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi

npm run wasm:build
npm run build
