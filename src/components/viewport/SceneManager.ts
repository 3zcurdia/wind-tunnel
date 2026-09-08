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
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DOMAIN } from "@/lib/sim/types";
import { VoxelDebugView } from "./VoxelDebugView";

export type DomainLayers = "particles" | "meshModel" | "smoke" | "debug";

const DOMAIN_SIZE = { x: 12.8, y: 4.8, z: 4.8 } as const;

/** Domain (lattice cells) → world mapping: 1 cell = 0.1 world units. */
const LATTICE_TO_WORLD = 0.1;
const WORLD_OFFSET = {
  x: (-DOMAIN.nx / 2) * LATTICE_TO_WORLD,
  y: (-DOMAIN.ny / 2) * LATTICE_TO_WORLD,
  z: (-DOMAIN.nz / 2) * LATTICE_TO_WORLD,
} as const;

type FrameCallback = (dtSeconds: number) => void;

export class SceneManager {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly canvasParent: HTMLElement;
  private readonly layers: Map<DomainLayers, Group> = new Map();
  private readonly subscribers: Set<FrameCallback> = new Set();
  private rafHandle: number | null = null;
  private lastFrameTime: number = 0;
  private disposed = false;
  private modelMesh: Mesh | null = null;
  private voxelView: VoxelDebugView | null = null;
  private voxelVisible = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvasParent = canvas.parentElement ?? document.body;

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

    const hemi = new HemisphereLight("#cfe8ff", "#202020", 0.9);
    const dir = new DirectionalLight(0xffffff, 1.2);
    dir.position.set(8, 12, 6);
    this.scene.add(hemi, dir);

    const domainEdges = new EdgesGeometry(
      new BoxGeometry(DOMAIN_SIZE.x, DOMAIN_SIZE.y, DOMAIN_SIZE.z),
    );
    const domainLine = new LineSegments(
      domainEdges,
      new LineBasicMaterial({ color: "#3b82f6", transparent: true, opacity: 0.6 }),
    );
    this.scene.add(domainLine);

    const ground = new GridHelper(20, 40, "#1f2937", "#111827");
    ground.position.y = -DOMAIN_SIZE.y / 2;
    this.scene.add(ground);

    const inletGeo = new BoxGeometry(1, DOMAIN_SIZE.y, DOMAIN_SIZE.z);
    const inletMat = new MeshBasicMaterial({
      color: "#22d3ee",
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    });
    const inlet = new Mesh(inletGeo, inletMat);
    inlet.position.x = -DOMAIN_SIZE.x / 2;
    this.scene.add(inlet);

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

    this.lastFrameTime = performance.now();
  }

  start(): void {
    if (this.rafHandle !== null || this.disposed) return;
    this.lastFrameTime = performance.now();
    const tick = (now: number) => {
      if (this.disposed) return;
      const dt = Math.max(0, (now - this.lastFrameTime) / 1000);
      this.lastFrameTime = now;
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
    if (!group) throw new Error(`Unknown layer: ${name}`);
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
    const matrix = new Matrix4().makeScale(
      LATTICE_TO_WORLD,
      LATTICE_TO_WORLD,
      LATTICE_TO_WORLD,
    );
    matrix.setPosition(WORLD_OFFSET.x, WORLD_OFFSET.y, WORLD_OFFSET.z);
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
    this.subscribers.clear();
    this.voxelView?.dispose();
    this.voxelView = null;
    this.resizeObserver.disconnect();
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
    return new Vector3(
      x * LATTICE_TO_WORLD + WORLD_OFFSET.x,
      y * LATTICE_TO_WORLD + WORLD_OFFSET.y,
      z * LATTICE_TO_WORLD + WORLD_OFFSET.z,
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
    target.scale.setScalar(LATTICE_TO_WORLD);
    target.position.set(WORLD_OFFSET.x, WORLD_OFFSET.y, WORLD_OFFSET.z);
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

  /** Toggle the debug voxel cloud (F006; F020 adds the real toggle). */
  setVoxelDebugVisible(on: boolean): void {
    this.voxelVisible = on;
    this.voxelView?.setVisible(on);
  }

  /** Remove the debug voxel cloud, if any. */
  clearVoxelDebug(): void {
    this.voxelView?.clear();
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.canvasParent;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }
}
