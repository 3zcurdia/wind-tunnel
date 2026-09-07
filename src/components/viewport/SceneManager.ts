import {
  BoxGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  FogExp2,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type DomainLayers = "particles" | "meshModel" | "smoke" | "debug";

const DOMAIN_SIZE = { x: 12.8, y: 4.8, z: 4.8 } as const;

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.subscribers.clear();
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

  private resize(): void {
    const { clientWidth, clientHeight } = this.canvasParent;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }
}
