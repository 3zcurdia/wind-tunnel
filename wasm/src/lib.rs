use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod voxel;

/// Shared solver/domain state (F006 skeleton; grown by later features).
///
/// `occupancy` is row-major (`idx = x + nx*(y + ny*z)`), `1` = solid.
/// `mesh_vertices` keeps deduplicated domain-space vertex positions for F012.
pub struct SimState {
    nx: usize,
    ny: usize,
    nz: usize,
    occupancy: Vec<u8>,
    solid_count: usize,
    mesh_vertices: Vec<f32>,
    vertex_count: usize,
    surface_mode: bool,
    /// Reserved for the F011 particle pool (allocated then).
    #[allow(dead_code)]
    particle_capacity: usize,
}

impl SimState {
    fn empty() -> Self {
        Self {
            nx: 0,
            ny: 0,
            nz: 0,
            occupancy: Vec::new(),
            solid_count: 0,
            mesh_vertices: Vec::new(),
            vertex_count: 0,
            surface_mode: false,
            particle_capacity: 0,
        }
    }

    fn fresh(nx: usize, ny: usize, nz: usize, particle_capacity: usize) -> Self {
        let total = nx.saturating_mul(ny).saturating_mul(nz);
        Self {
            nx,
            ny,
            nz,
            occupancy: vec![0u8; total],
            solid_count: 0,
            mesh_vertices: Vec::new(),
            vertex_count: 0,
            surface_mode: false,
            particle_capacity,
        }
    }
}

thread_local! {
    static STATE: RefCell<SimState> = RefCell::new(SimState::empty());
}

/// Temporary pipeline probe (F003). Removed with F019.
#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}

/// Allocate domain & solver state. Safe to call again to rebuild (resets
/// everything). Zero-sized domains yield an empty (valid) state, never a panic.
#[wasm_bindgen]
pub fn init_sim(nx: u32, ny: u32, nz: u32, particle_capacity: u32) {
    let (nx, ny, nz) = (nx as usize, ny as usize, nz as usize);
    STATE.with(|s| {
        *s.borrow_mut() = SimState::fresh(nx, ny, nz, particle_capacity as usize);
    });
}

/// Voxelize a mesh. Triangles are 9 floats each, in DOMAIN space.
/// Returns the number of solid cells. Replaces any previous mesh.
/// Malformed input (empty, or length % 9 != 0) returns 0 and leaves the
/// previous state untouched — no panics.
#[wasm_bindgen]
pub fn set_mesh(triangles: &[f32]) -> u32 {
    if triangles.is_empty() || triangles.len() % 9 != 0 {
        return 0;
    }
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.nx == 0 || state.ny == 0 || state.nz == 0 || state.occupancy.is_empty() {
            return 0;
        }
        let res = voxel::voxelize(state.nx, state.ny, state.nz, triangles);
        state.occupancy = res.occupancy;
        state.solid_count = res.solid_count;
        state.surface_mode = res.surface_mode;
        state.mesh_vertices = voxel::deduplicate_vertices(triangles);
        state.vertex_count = state.mesh_vertices.len() / 3;
        state.solid_count as u32
    })
}

/// Remove the current mesh; the grid returns to all-fluid.
#[wasm_bindgen]
pub fn clear_mesh() {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.occupancy.fill(0);
        state.solid_count = 0;
        state.mesh_vertices.clear();
        state.vertex_count = 0;
        state.surface_mode = false;
    });
}

/// Pointer to the obstacle grid (1 byte per cell, row-major as §3).
/// Stable only until the next allocation-triggering call (`init_sim`,
/// `set_mesh`); re-fetch via this function afterwards. Null when empty.
#[wasm_bindgen]
pub fn occupancy_ptr() -> *const u8 {
    STATE.with(|s| {
        let state = s.borrow();
        if state.occupancy.is_empty() {
            std::ptr::null()
        } else {
            state.occupancy.as_ptr()
        }
    })
}

/// Length of the obstacle grid in bytes (`nx*ny*nz`).
#[wasm_bindgen]
pub fn occupancy_len() -> u32 {
    STATE.with(|s| s.borrow().occupancy.len() as u32)
}

/// True when the last `set_mesh` fell back to surface-only mode (leaky mesh).
#[wasm_bindgen]
pub fn surface_mode_flag() -> bool {
    STATE.with(|s| s.borrow().surface_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set_mesh` rejects malformed input without panicking and the state
    /// stays usable for subsequent calls.
    #[test]
    fn malformed_set_mesh_keeps_valid_state() {
        init_sim(16, 16, 16, 100);
        assert_eq!(set_mesh(&[]), 0);
        assert_eq!(set_mesh(&[1.0, 2.0, 3.0, 4.0]), 0);
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(!surface_mode_flag());
        // A subsequent valid call still works (single triangle → shell mode).
        let tri: Vec<f32> = vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 2.0, 1.0];
        assert!(set_mesh(&tri) > 0);
        assert!(surface_mode_flag());
        clear_mesh();
        assert_eq!(occupancy_len(), 16 * 16 * 16);
        assert!(STATE.with(|s| s.borrow().occupancy.iter().all(|&c| c == 0)));
    }
}
