import { Matrix4, Vector3, type BufferGeometry } from "three";
import type { GridDims } from "../sim/quality";
import { DOMAIN, DegenerateModelError, type Vec3 } from "../sim/types";

export interface NormalizedModel {
  /** Domain-space (lattice cells) copy; the input geometry is left untouched. */
  geometry: BufferGeometry;
  transform: { scale: number; translation: [number, number, number] };
  /** Axis-aligned bounding box of the normalized geometry, in lattice cells. */
  bboxLattice: { min: Vec3; max: Vec3 };
}

/**
 * Map model space → domain space (ARCHITECTURE.md §3): uniform scale so the
 * longest bbox side equals 0.25·nx cells, then translate so the bbox center
 * lands at (0.35·nx, ny/2, nz/2). The input geometry is cloned, never mutated.
 * Throws DegenerateModelError on zero-size bounding boxes.
 *
 * `dims` selects the target grid (F021 — the loop passes the engine's live
 * dims); omitted it targets the compile-time `DOMAIN` (the High tier), which
 * keeps earlier callers and harnesses behavior-identical.
 */
export function normalizeToDomain(
  geometry: BufferGeometry,
  dims?: GridDims,
): NormalizedModel {
  const nx = dims?.nx ?? DOMAIN.nx;
  const ny = dims?.ny ?? DOMAIN.ny;
  const nz = dims?.nz ?? DOMAIN.nz;
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    throw new DegenerateModelError("Model has no vertices");
  }
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (!bbox) {
    throw new DegenerateModelError("Model has no bounding box");
  }
  const size = bbox.getSize(new Vector3());
  const center = bbox.getCenter(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (!(longest > 0) || !Number.isFinite(longest)) {
    throw new DegenerateModelError("Model has zero-size bounding box");
  }
  const targetSize = 0.25 * nx;
  const scale = targetSize / longest;
  const targetCenter: [number, number, number] = [
    0.35 * nx,
    ny / 2,
    nz / 2,
  ];
  const translation: [number, number, number] = [
    targetCenter[0] - center.x * scale,
    targetCenter[1] - center.y * scale,
    targetCenter[2] - center.z * scale,
  ];
  const matrix = new Matrix4().makeScale(scale, scale, scale);
  matrix.setPosition(translation[0], translation[1], translation[2]);

  const out = geometry.clone();
  out.applyMatrix4(matrix);
  out.computeBoundingBox();
  const outBox = out.boundingBox;
  if (!outBox) {
    throw new DegenerateModelError("Normalization produced no bounding box");
  }
  return {
    geometry: out,
    transform: { scale, translation },
    bboxLattice: {
      min: [outBox.min.x, outBox.min.y, outBox.min.z],
      max: [outBox.max.x, outBox.max.y, outBox.max.z],
    },
  };
}
