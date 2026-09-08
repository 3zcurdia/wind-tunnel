import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  FogExp2,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Spherical,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AppError } from "@/lib/sim/errors";
import type { GridDims } from "@/lib/sim/quality";
import { DOMAIN } from "@/lib/sim/types";
import { VoxelDebugView } from "./VoxelDebugView";

export type DomainLayers = "particles" | "meshModel" | "smoke" | "debug";

/** Camera preset identifiers (F020 §1). */
export type CameraPreset = "front" | "top" | "iso";

/** Thrown by `SceneManager.screenshot()` when the GL context is lost (F020). */
export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotError";
  }
}

/**
 * Preset camera offsets from the current orbit target (F020 §1), distance
 * ≈ 18 world units. `front` sits on the +Z axis so the wind (+X,
 * ARCHITECTURE.md §3) reads left→right on screen — the spec's printed
 * "(−18, 0, 0)" would align the flow with the view axis (see
 * DECISIONS.md §F020.1). `iso` is the F002 default position.
 */
const CAMERA_PRESET_OFFSETS: Record<CameraPreset, Readonly<Vector3>> = {
  front: new Vector3(0, 0, 18),
  top: new Vector3(0, 18, 0),
  iso: new Vector3(14, 7, 14),
};

/** Default camera-preset tween duration (F020: "~600 ms"). */
const CAMERA_TWEEN_DEFAULT_MS = 600;

/** F020 §1 easing; pure function, pinned headless (DECISIONS.md §F020.1). */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Active camera-preset flight; null when idle (F020). */
interface CameraTween {
  readonly startedMs: number;
  readonly durationMs: number;
  /** Orbit target, frozen at tween start (F020 §1: "the current target"). */
  readonly target: Vector3;
  readonly from: Spherical;
  readonly to: Spherical;
}

/** World-space size of the domain box for the given grid (0.1/cell). */
function domainWorldSize(dims: GridDims): { x: number; y: number; z: number } {
  return {
    x: dims.nx * LATTICE_TO_WORLD,
    y: dims.ny * LATTICE_TO_WORLD,
    z: dims.nz * LATTICE_TO_WORLD,
  };
}

/** Domain (lattice cells) → world mapping: 1 cell = 0.1 world units. */
const LATTICE_TO_WORLD = 0.1;

/** Default grid (the F021 High tier) — matches the constructor-built box. */
const DEFAULT_DIMS: GridDims = {
  nx: DOMAIN.nx,
  ny: DOMAIN.ny,
  nz: DOMAIN.nz,
};

/** True for a usable grid (positive finite integers — F021 validation). */
function isValidDims(dims: GridDims): boolean {
  return (
    Number.isInteger(dims.nx) &&
    Number.isInteger(dims.ny) &&
    Number.isInteger(dims.nz) &&
    dims.nx > 0 &&
    dims.ny > 0 &&
    dims.nz > 0 &&
    Number.isFinite(dims.nx + dims.ny + dims.nz)
  );
}

type FrameCallback = (dtSeconds: number) => void;

export class SceneManager {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly canvasParent: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly layers: Map<DomainLayers, Group> = new Map();
  private readonly subscribers: Set<FrameCallback> = new Set();
  private readonly domainGroup: Group = new Group();
  private cameraTween: CameraTween | null = null;
  /** Current lattice grid (F021 runtime state — was the `DOMAIN` constant). */
  private dims: GridDims = { ...DEFAULT_DIMS };
  /** OrbitControls `start` handler: user input cancels any preset flight. */
  private readonly cancelCameraTween = (): void => {
    this.cameraTween = null;
  };
  private rafHandle: number | null = null;
  private lastFrameTime: number = 0;
  private disposed = false;
  /** F022 §4: true between `webglcontextlost` and `webglcontextrestored`. */
  private contextLost = false;
  /** F022 §4: subscribers for context loss / restore (unsubscribe on use). */
  private readonly contextLostListeners: Set<() => void> = new Set();
  private readonly contextRestoredListeners: Set<() => void> = new Set();
  /**
   * F022 §4: `preventDefault` keeps the restore path alive (without it the
   * loss is permanent); the loop pauses and the page overlay owns the UI.
   */
  private readonly handleWebGLContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.contextLost || this.disposed) return;
    this.contextLost = true;
    this.stop();
    for (const cb of this.contextLostListeners) {
      try {
        cb();
      } catch (err) {
        console.error("[viewport] context-lost listener failed", err);
      }
    }
  };
  /**
   * F022 §4: re-upload SceneManager-owned resources (domain box, grid,
   * lights, model material) and resume. Shader programs recompile via
   * `needsUpdate`; buffer attributes re-upload on the next flagged write
   * (viz per-frame updates re-flag everything anyway). Viz classes holding
   * GL state re-attach through `onContextRestored`.
   */
  private readonly handleWebGLContextRestored = (): void => {
    if (!this.contextLost || this.disposed) return;
    this.scene.traverse((obj) => {
      const typed = obj as unknown as {
        geometry?: { attributes: Record<string, { needsUpdate: boolean }> };
        material?: { needsUpdate: boolean } | { needsUpdate: boolean }[];
      };
      const geometry = typed.geometry;
      if (geometry) {
        for (const attr of Object.values(geometry.attributes)) {
          attr.needsUpdate = true;
        }
      }
      const material = typed.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.needsUpdate = true;
      } else if (material) {
        material.needsUpdate = true;
      }
    });
    this.contextLost = false;
    this.start();
    for (const cb of this.contextRestoredListeners) {
      try {
        cb();
      } catch (err) {
        console.error("[viewport] context-restored listener failed", err);
      }
    }
  };
  private modelMesh: Mesh | null = null;
  private voxelView: VoxelDebugView | null = null;
  private voxelVisible = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvasParent = canvas.parentElement ?? document.body;
    this.canvas = canvas;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.scene.background = new Color("#0b0d10");
    this.scene.fog = new FogExp2("#0b0d10", 0.015);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(14, 7, 14);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 60;
    // F020: grabbing the scene mid-tween cancels the preset flight.
    this.controls.addEventListener("start", this.cancelCameraTween);

    const hemi = new HemisphereLight("#cfe8ff", "#202020", 0.9);
    const dir = new DirectionalLight(0xffffff, 1.2);
    dir.position.set(8, 12, 6);
    this.scene.add(hemi, dir);

    // Box + grid + inlet marker share one group so F020's
    // `setDomainBoxVisible` toggles them as a unit. Sized from the current
    // dims (F021) — the default dims reproduce the original 12.8×4.8×4.8 box.
    this.domainGroup.name = "domainBox";
    this.buildDomainContents();
    this.scene.add(this.domainGroup);

    const layerNames: DomainLayers[] = [
      "particles",
      "meshModel",
      "smoke",
      "debug",
    ];
    for (const name of layerNames) {
      const group = new Group();
      group.name = name;
      this.layers.set(name, group);
      this.scene.add(group);
    }
    // The particles layer carries the lattice→world map as a parent transform
    // (F014) — ParticleSystem re-applies the same transform on construction.
    this.applyLatticeTransform(this.getLayer("particles"));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvasParent);
    this.resize();

    // F022 §4: context-loss plumbing (removed again in dispose()).
    canvas.addEventListener("webglcontextlost", this.handleWebGLContextLost);
    canvas.addEventListener(
      "webglcontextrestored",
      this.handleWebGLContextRestored,
    );

    this.lastFrameTime = performance.now();
  }

  start(): void {
    if (this.rafHandle !== null || this.disposed) return;
    this.lastFrameTime = performance.now();
    const tick = (now: number) => {
      if (this.disposed) return;
      const dt = Math.max(0, (now - this.lastFrameTime) / 1000);
      this.lastFrameTime = now;
      this.advanceCameraTween(now);
      this.controls.update();
      for (const cb of this.subscribers) cb(dt);
      if (!document.hidden) this.renderer.render(this.scene, this.camera);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  onFrame(cb: FrameCallback): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  getLayer(name: DomainLayers): Group {
    const group = this.layers.get(name);
    if (!group) throw new AppError("unknown", "Unknown viewport layer");
    return group;
  }

  /**
   * Show a domain-space (lattice cells) model in the viewport (F005).
   * The input geometry is cloned and mapped to world space
   * (world = (lattice − domainCenter) · 0.1); the caller's copy is untouched
   * so it stays usable for voxelization. Replaces any previous model cleanly.
   */
  showModel(geometry: BufferGeometry): void {
    this.clearModel();
    const world = geometry.clone();
    if (world.getAttribute("normal") === undefined) {
      world.computeVertexNormals();
    }
    const offset = this.worldOffset();
    const matrix = new Matrix4().makeScale(
      LATTICE_TO_WORLD,
      LATTICE_TO_WORLD,
      LATTICE_TO_WORLD,
    );
    matrix.setPosition(offset.x, offset.y, offset.z);
    world.applyMatrix4(matrix);
    const material = new MeshStandardMaterial({
      color: "#9ca3af",
      metalness: 0.1,
      roughness: 0.65,
      flatShading: true,
    });
    const mesh = new Mesh(world, material);
    this.modelMesh = mesh;
    this.getLayer("meshModel").add(mesh);

    world.computeBoundingBox();
    const center = world.boundingBox?.getCenter(new Vector3());
    if (center) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(offset);
      this.controls.update();
    }
  }

  /** Remove the current model, if any, and release its GPU resources. */
  clearModel(): void {
    const mesh = this.modelMesh;
    this.modelMesh = null;
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material.dispose();
    }
  }

  /**
   * Live model geometry (the world-space clone owned by the scene), or null
   * when no model is shown (F015: the heatmap driver needs it for
   * `HeatmapOverlay.attach` — reaching through the `meshModel` layer
   * children would break encapsulation).
   */
  getModelGeometry(): BufferGeometry | null {
    return this.modelMesh?.geometry ?? null;
  }

  /**
   * Toggle vertex-color rendering on the model material (F015): the heatmap
   * writes a `color` attribute — enabling shows it, disabling restores the
   * plain base color. No-op when no model is shown.
   */
  setModelVertexColors(on: boolean): void {
    const mesh = this.modelMesh;
    if (!mesh) return;
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const material of materials) {
      if (material.vertexColors !== on) {
        material.vertexColors = on;
        material.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener(
      "webglcontextlost",
      this.handleWebGLContextLost,
    );
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleWebGLContextRestored,
    );
    this.contextLostListeners.clear();
    this.contextRestoredListeners.clear();
    this.cameraTween = null;
    this.subscribers.clear();
    this.voxelView?.dispose();
    this.voxelView = null;
    this.resizeObserver.disconnect();
    this.controls.removeEventListener("start", this.cancelCameraTween);
    this.controls.dispose();
    this.scene.traverse((obj) => {
      const m = obj as unknown as {
        geometry?: { dispose: () => void };
        material?: { dispose: () => void } | { dispose: () => void }[];
      };
      if (m.geometry?.dispose) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) {
        for (const entry of mat) entry.dispose();
      } else if (mat?.dispose) {
        mat.dispose();
      }
    });
    this.renderer.dispose();
    this.layers.clear();
  }

  /**
   * Map continuous domain-space (lattice) coords to world space (F006).
   * Inverse of F005's world mapping: `world = (lattice − center) · 0.1`.
   */
  latticeToWorld(x: number, y: number, z: number): Vector3 {
    const offset = this.worldOffset();
    return new Vector3(
      x * LATTICE_TO_WORLD + offset.x,
      y * LATTICE_TO_WORLD + offset.y,
      z * LATTICE_TO_WORLD + offset.z,
    );
  }

  /**
   * Apply the lattice→world mapping as a parent `Group` transform (F014):
   * uniform scale plus the centering offset, matching `latticeToWorld`
   * exactly. Idempotent — re-applying is a no-op assignment. Viz classes
   * holding lattice-space positions (e.g. `ParticleSystem`) render under a
   * group configured this way instead of converting per vertex.
   */
  applyLatticeTransform(target: Group): void {
    const offset = this.worldOffset();
    target.scale.setScalar(LATTICE_TO_WORLD);
    target.position.set(offset.x, offset.y, offset.z);
  }

  /**
   * Rebuild the debug voxel cloud from an occupancy snapshot (F006).
   * Creates the view lazily in the `debug` layer; throttled inside the view.
   */
  updateVoxelDebug(occupancy: Uint8Array, nx: number, ny: number, nz: number): void {
    if (!this.voxelView) {
      this.voxelView = new VoxelDebugView(this.getLayer("debug"), (x, y, z) =>
        this.latticeToWorld(x, y, z),
      );
      this.voxelView.setVisible(this.voxelVisible);
    }
    this.voxelView.update(occupancy, nx, ny, nz);
  }

  /**
   * Toggle the debug voxel cloud (F006; the F020 Layers toggle drives this).
   * Note: nothing feeds `updateVoxelDebug` in v1, so the cloud stays empty —
   * see DECISIONS.md §F020.2.
   */
  setVoxelDebugVisible(on: boolean): void {
    this.voxelVisible = on;
    this.voxelView?.setVisible(on);
  }

  /** Remove the debug voxel cloud, if any. */
  clearVoxelDebug(): void {
    this.voxelView?.clear();
  }

  /**
   * Fly the camera to a preset view (F020 §1): easeInOutCubic spherical
   * interpolation of the position around the *current* orbit target (the
   * target itself stays frozen — DECISIONS.md §F020.1). Any OrbitControls
   * interaction (its `start` event) cancels the flight mid-tween.
   * `animateMs <= 0` snaps instantly.
   */
  setCameraPreset(preset: CameraPreset, animateMs: number = CAMERA_TWEEN_DEFAULT_MS): void {
    const target = this.controls.target.clone();
    const destination = CAMERA_PRESET_OFFSETS[preset].clone().add(target);
    if (animateMs <= 0) {
      this.cameraTween = null;
      this.camera.position.copy(destination);
      this.camera.lookAt(target);
      return;
    }
    const from = new Spherical().setFromVector3(
      this.camera.position.clone().sub(target),
    );
    const to = new Spherical().setFromVector3(
      destination.clone().sub(target),
    );
    // Shortest-path azimuth: a raw theta lerp could swing the long way around.
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    to.theta = from.theta + dTheta;
    this.cameraTween = {
      startedMs: performance.now(),
      durationMs: animateMs,
      target,
      from,
      to,
    };
  }

  /** Show/hide a whole viz layer group (F020 §1). */
  setLayerVisible(layer: DomainLayers, visible: boolean): void {
    this.getLayer(layer).visible = visible;
  }

  /** Show/hide the domain box edges, ground grid, and inlet marker (F020). */
  setDomainBoxVisible(on: boolean): void {
    this.domainGroup.visible = on;
  }

  /** True between `webglcontextlost` and `webglcontextrestored` (F022 §4). */
  isContextLost(): boolean {
    return this.contextLost;
  }

  /**
   * Subscribe to graphics-context loss (F022 §4): the page overlay shows
   * "Graphics context lost — Reload" from this. Returns an unsubscribe
   * function — call it on unmount.
   */
  onContextLost(cb: () => void): () => void {
    this.contextLostListeners.add(cb);
    return () => {
      this.contextLostListeners.delete(cb);
    };
  }

  /**
   * Subscribe to graphics-context restore (F022 §4): SceneManager-owned
   * objects (box/grid/lights/model) are rebuilt internally before these
   * fire; viz classes holding GL state must re-attach through this list.
   * Returns an unsubscribe function — call it on unmount.
   */
  onContextRestored(cb: () => void): () => void {
    this.contextRestoredListeners.add(cb);
    return () => {
      this.contextRestoredListeners.delete(cb);
    };
  }

  /** Current lattice grid in cells (F021 runtime state). */
  getDomainDims(): GridDims {
    return { ...this.dims };
  }

  /**
   * Switch the rendered domain to a new grid (F021): rebuilds the box edges,
   * ground grid, and inlet marker at the new world size (world scale stays
   * 0.1/cell) and re-applies the lattice→world parent transform to the
   * particles/smoke layers so viz built for the old grid re-seats correctly.
   * Camera presets are unchanged (fixed 18-unit offsets). Invalid dims are
   * ignored (no-throw — panel paths must not crash); unchanged dims skip the
   * rebuild. GPU resources of the replaced box are disposed.
   */
  setDomainDims(dims: GridDims): void {
    if (!isValidDims(dims)) return;
    if (
      dims.nx === this.dims.nx &&
      dims.ny === this.dims.ny &&
      dims.nz === this.dims.nz
    ) {
      return;
    }
    this.dims = { nx: dims.nx, ny: dims.ny, nz: dims.nz };
    this.buildDomainContents();
    this.applyLatticeTransform(this.getLayer("particles"));
    this.applyLatticeTransform(this.getLayer("smoke"));
  }

  /**
   * (Re)build the domain box contents for `this.dims`: edge lines, ground
   * grid, and inlet marker. Disposes the previous contents' GPU resources.
   */
  private buildDomainContents(): void {
    for (const child of [...this.domainGroup.children]) {
      child.removeFromParent();
      const typed = child as unknown as {
        geometry?: { dispose: () => void };
        material?: { dispose: () => void } | { dispose: () => void }[];
      };
      typed.geometry?.dispose();
      const material = typed.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material?.dispose();
      }
    }
    const size = domainWorldSize(this.dims);
    const domainEdges = new EdgesGeometry(
      new BoxGeometry(size.x, size.y, size.z),
    );
    const domainLine = new LineSegments(
      domainEdges,
      new LineBasicMaterial({ color: "#3b82f6", transparent: true, opacity: 0.6 }),
    );

    const ground = new GridHelper(20, 40, "#1f2937", "#111827");
    ground.position.y = -size.y / 2;

    const inletGeo = new BoxGeometry(1, size.y, size.z);
    const inletMat = new MeshBasicMaterial({
      color: "#22d3ee",
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    });
    const inlet = new Mesh(inletGeo, inletMat);
    inlet.position.x = -size.x / 2;

    this.domainGroup.add(domainLine, ground, inlet);
  }

  /** Centering offset of the lattice→world mapping for the current dims. */
  private worldOffset(): { x: number; y: number; z: number } {
    return {
      x: (-this.dims.nx / 2) * LATTICE_TO_WORLD,
      y: (-this.dims.ny / 2) * LATTICE_TO_WORLD,
      z: (-this.dims.nz / 2) * LATTICE_TO_WORLD,
    };
  }

  /**
   * PNG dataURL of the current view (F020 §2). Renders one fresh frame and
   * reads the drawing buffer synchronously in the same task — no standing
   * `preserveDrawingBuffer: true` cost (the spec-allowed alternative;
   * choice recorded in DECISIONS.md §F020.3). Throws `ScreenshotError`
   * when the GL context is lost.
   */
  screenshot(): string {
    if (this.renderer.getContext().isContextLost()) {
      throw new ScreenshotError(
        "WebGL context is lost — cannot capture the viewport",
      );
    }
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  /**
   * Advance the active camera-preset flight (F020). Runs once per frame
   * before `controls.update()`: idle OrbitControls re-derive their internal
   * state from the position written here (no pending deltas), so the two
   * never fight.
   */
  private advanceCameraTween(now: number): void {
    const tween = this.cameraTween;
    if (!tween) return;
    const t = Math.min(1, (now - tween.startedMs) / tween.durationMs);
    const eased = easeInOutCubic(t);
    const position = new Vector3().setFromSphericalCoords(
      tween.from.radius + (tween.to.radius - tween.from.radius) * eased,
      tween.from.phi + (tween.to.phi - tween.from.phi) * eased,
      tween.from.theta + (tween.to.theta - tween.from.theta) * eased,
    );
    this.camera.position.copy(position.add(tween.target));
    this.camera.lookAt(tween.target);
    if (t >= 1) this.cameraTween = null;
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.canvasParent;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }
}
