import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  type Group,
  type Vector3,
} from "three";

/** Maximum debug instances (spec); beyond this, solids decimate by stride. */
export const VOXEL_DEBUG_MAX_INSTANCES = 60000;

/**
 * Minimum time between rebuilds in ms — the view rebuilds at most 1×/s
 * (spec). Uploads are user-paced, so the gate rarely triggers; a call inside
 * the window keeps the previous mesh.
 */
const REBUILD_MIN_INTERVAL_MS = 1000;

/** Maps continuous domain-space (lattice) coords to world space. */
export type LatticeToWorld = (x: number, y: number, z: number) => Vector3;

/**
 * Debug-only voxel cloud (F006): one reddish cube per solid cell in the
 * SceneManager `debug` layer. Owned by SceneManager — the only module that
 * touches three.js scene objects.
 *
 * Cube edge is 0.09 world units = 0.9 lattice cells × 0.1 (see DECISIONS.md):
 * one slightly-gapped cube per cell.
 */
export class VoxelDebugView {
  private mesh: InstancedMesh | null = null;
  private readonly boxGeometry = new BoxGeometry(0.09, 0.09, 0.09);
  private readonly material = new MeshBasicMaterial({
    color: "#ef4444",
    transparent: true,
    opacity: 0.8,
  });
  private readonly scratch = new Matrix4();
  private lastBuildMs = 0;
  private visible = false;

  /** Total solid cells seen in the last update. */
  total = 0;
  /** Instances actually shown (after stride decimation). */
  shown = 0;
  /** True when the cap forced stride decimation (F020 surfaces this). */
  decimated = false;

  constructor(
    private readonly layer: Group,
    private readonly latticeToWorld: LatticeToWorld,
  ) {}

  /** Rebuild the cloud from a row-major occupancy snapshot. Throttled. */
  update(occupancy: Uint8Array, nx: number, ny: number, nz: number): void {
    const now = performance.now();
    if (now - this.lastBuildMs < REBUILD_MIN_INTERVAL_MS) return;
    this.lastBuildMs = now;
    this.removeMesh();

    let total = 0;
    for (let i = 0; i < occupancy.length; i += 1) {
      if (occupancy[i] === 1) total += 1;
    }
    this.total = total;
    this.shown = 0;
    this.decimated = false;
    if (total === 0 || nx <= 0 || ny <= 0 || nz <= 0) return;

    const stride = Math.max(1, Math.ceil(total / VOXEL_DEBUG_MAX_INSTANCES));
    this.decimated = stride > 1;

    const count = Math.ceil(total / stride);
    const mesh = new InstancedMesh(this.boxGeometry, this.material, count);
    // Instance spreads have no meaningful single bounds — a default-culled
    // InstancedMesh would vanish when its base geometry leaves the frustum.
    mesh.frustumCulled = false;
    mesh.visible = this.visible;

    let seen = 0;
    let placed = 0;
    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          const idx = x + nx * (y + ny * z);
          if (idx >= occupancy.length || occupancy[idx] !== 1) continue;
          if (seen % stride === 0) {
            // Cell (x,y,z) spans [x,x+1) in lattice space — use its center.
            const p = this.latticeToWorld(x + 0.5, y + 0.5, z + 0.5);
            this.scratch.makeTranslation(p.x, p.y, p.z);
            mesh.setMatrixAt(placed, this.scratch);
            placed += 1;
          }
          seen += 1;
        }
      }
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.shown = placed;
    this.mesh = mesh;
    this.layer.add(mesh);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.mesh) this.mesh.visible = on;
  }

  /** Remove the current cloud, if any (keeps shared geometry/material). */
  clear(): void {
    this.removeMesh();
    this.total = 0;
    this.shown = 0;
    this.decimated = false;
  }

  dispose(): void {
    this.clear();
    this.boxGeometry.dispose();
    this.material.dispose();
  }

  private removeMesh(): void {
    if (!this.mesh) return;
    this.layer.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }
}
