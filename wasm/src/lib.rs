use wasm_bindgen::prelude::*;

/// Temporary pipeline probe (F003). Removed with F019.
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}
