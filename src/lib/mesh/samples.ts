import {
  BoxGeometry,
  LatheGeometry,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
} from "three";
import { AppError } from "../sim/errors";

export type SampleId = "sphere" | "cube" | "teardrop";

export interface SampleDef {
  id: SampleId;
  label: string;
  description: string;
}

export const SAMPLES: SampleDef[] = [
  {
    id: "sphere",
    label: "Sphere",
    description: "Bluff body — stagnation point ahead, wake behind.",
  },
  {
    id: "cube",
    label: "Cube",
    description: "Sharp edges, face-on — big separation, high drag.",
  },
  {
    id: "teardrop",
    label: "Teardrop",
    description: "Streamlined car-ish body — attached flow, low drag.",
  },
];

/** Display name used for toasts/stats when a sample is the active model. */
export function sampleDisplayName(id: SampleId): string {
  const def = SAMPLES.find((entry) => entry.id === id);
  return `Sample: ${def?.label ?? id}`;
}

/**
 * Build a built-in sample model (F023). The returned geometry matches the
 * `parseModel` output shape (indexed BufferGeometry with positions, normals,
 * and an index divisible by 3) so the pipeline accepts either source via the
 * converged "normalized geometry ready" state (`normalizeToDomain` clones
 * its input — the caller owns this geometry and must dispose it).
 */
export function buildSampleGeometry(id: SampleId): BufferGeometry {
  switch (id) {
    case "sphere":
      return new SphereGeometry(0.5, 48, 32);
    case "cube":
      // Box faces align with the axes, so the +X face already points
      // downstream-normal (face-on to the wind).
      return new BoxGeometry(0.5, 0.5, 0.5, 1, 1, 1);
    case "teardrop":
      return buildTeardrop();
    default:
      throw new AppError("unknown", "Unknown sample");
  }
}

/**
 * Lathe-built car-ish body (F023 — aesthetic, not precise): rounded nose,
 * cylindrical mid-section, tapering tail. ~64 profile points × 48 segments.
 *
 * The profile runs nose tip (t=0, y=−0.5) → tail tip (t=1, y=+0.5) with a
 * beta-shaped radius `r ∝ t^0.7·(1−t)^1.3` peaking at t=0.35 (toward the
 * nose), so the nose is blunt and the tail tapers. Lathe produces a Y-axis
 * body, so the geometry is rotated −90° about Z: +Y (tail) → +X
 * (downstream) and the rounded nose faces −X (upstream — the wind blows
 * along +X from the inlet at x=0).
 */
function buildTeardrop(): BufferGeometry {
  const PROFILE_POINTS = 64;
  const SEGMENTS = 48;
  const HALF_LENGTH = 0.5;
  const MAX_RADIUS = 0.25;
  const NOSE_EXPONENT = 0.7;
  const TAIL_EXPONENT = 1.3;
  const PEAK_T = NOSE_EXPONENT / (NOSE_EXPONENT + TAIL_EXPONENT);
  const peakValue =
    Math.pow(PEAK_T, NOSE_EXPONENT) * Math.pow(1 - PEAK_T, TAIL_EXPONENT);

  const points: Vector2[] = [];
  for (let i = 0; i < PROFILE_POINTS; i += 1) {
    const t = i / (PROFILE_POINTS - 1);
    const y = -HALF_LENGTH + t * 2 * HALF_LENGTH;
    const raw =
      Math.pow(t, NOSE_EXPONENT) * Math.pow(1 - t, TAIL_EXPONENT);
    const radius = raw <= 0 ? 0 : (MAX_RADIUS * raw) / peakValue;
    points.push(new Vector2(radius, y));
  }
  const geometry = new LatheGeometry(points, SEGMENTS);
  geometry.rotateZ(-Math.PI / 2);
  return geometry;
}
