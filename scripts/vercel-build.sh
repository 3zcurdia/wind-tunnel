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

# The Vercel build image may ship rustup/cargo proxy binaries, so a bare
# `command -v cargo` check is unreliable — install the toolchain explicitly
# into our RUSTUP_HOME and set it as default (no-op when already cached).
if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown
rustup default stable

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "Installing wasm-pack..."
  curl --proto '=https' --tlsv1.2 -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi

npm run wasm:build
npm run build
