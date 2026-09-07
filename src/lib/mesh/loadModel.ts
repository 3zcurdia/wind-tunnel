import { BufferAttribute, BufferGeometry, type Mesh } from "three";
import { ModelParseError } from "../sim/types";
import type { LoadedFile } from "../sim/types";

export interface ParsedModel {
  geometry: BufferGeometry;
  /** Position vertex count. */
  vertices: number;
  /** Triangle count: index.count/3, or position.count/3 when non-indexed. */
  triangles: number;
}

function countsOf(geometry: BufferGeometry): { vertices: number; triangles: number } {
  const position = geometry.getAttribute("position");
  const vertices = position?.count ?? 0;
  const index = geometry.getIndex();
  const triangles = index ? Math.floor(index.count / 3) : Math.floor(vertices / 3);
  return { vertices, triangles };
}

function isMeshObject(obj: unknown): obj is Mesh {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Mesh).isMesh === true &&
    (obj as Mesh).geometry !== undefined
  );
}

/**
 * Parse an uploaded OBJ/PLY file into a single BufferGeometry (F005).
 * OBJ groups with multiple child meshes are merged into one body.
 * Rejects with ModelParseError on garbage input.
 */
export async function parseModel(file: LoadedFile): Promise<ParsedModel> {
  if (file.format === "obj") {
    return parseObj(file);
  }
  return parsePly(file);
}

function parseError(file: LoadedFile, detail: unknown): ModelParseError {
  const msg = detail instanceof Error ? detail.message : String(detail);
  return new ModelParseError(`Failed to parse ${file.name}: ${msg}`);
}

async function parseObj(file: LoadedFile): Promise<ParsedModel> {
  const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(file.data);
  } catch (err) {
    throw parseError(file, err);
  }
  let group: { traverse: (cb: (obj: unknown) => void) => void };
  try {
    group = new OBJLoader().parse(text);
  } catch (err) {
    throw parseError(file, err);
  }
  const parts: BufferGeometry[] = [];
  group.traverse((obj: unknown) => {
    if (isMeshObject(obj)) {
      const geo = obj.geometry as BufferGeometry;
      if (geo.getAttribute("position") !== undefined) parts.push(geo);
    }
  });
  if (parts.length === 0) {
    throw new ModelParseError(`Failed to parse ${file.name}: OBJ contains no geometry`);
  }
  let geometry: BufferGeometry;
  if (parts.length === 1) {
    const only = parts[0];
    if (!only) {
      throw new ModelParseError(`Failed to parse ${file.name}: OBJ is empty`);
    }
    geometry = only;
  } else {
    const { mergeGeometries } = await import(
      "three/addons/utils/BufferGeometryUtils.js"
    );
    geometry =
      mergeGeometries(parts, false) ?? mergePositionsOnly(file, parts);
  }
  const { vertices, triangles } = countsOf(geometry);
  if (vertices === 0 || triangles === 0) {
    throw new ModelParseError(
      `Failed to parse ${file.name}: OBJ contains no triangles`,
    );
  }
  return { geometry, vertices, triangles };
}

/**
 * Fallback merge when attribute sets differ across OBJ parts:
 * concatenate positions only (normals are recomputed at display time).
 */
function mergePositionsOnly(file: LoadedFile, parts: BufferGeometry[]): BufferGeometry {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const part of parts) {
    const expanded = part.getIndex() ? part.toNonIndexed() : part;
    const pos = expanded.getAttribute("position");
    if (!pos) {
      throw new ModelParseError(
        `Failed to parse ${file.name}: could not merge OBJ parts`,
      );
    }
    const arr = new Float32Array(pos.array);
    chunks.push(arr);
    total += arr.length;
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(merged, 3));
  return out;
}

async function parsePly(file: LoadedFile): Promise<ParsedModel> {
  const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
  let geometry: BufferGeometry;
  try {
    geometry = new PLYLoader().parse(file.data);
  } catch (err) {
    throw parseError(file, err);
  }
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    throw new ModelParseError(
      `Failed to parse ${file.name}: PLY contains no geometry`,
    );
  }
  const { vertices, triangles } = countsOf(geometry);
  if (triangles === 0) {
    throw new ModelParseError(
      `Failed to parse ${file.name}: PLY contains no triangles`,
    );
  }
  return { geometry, vertices, triangles };
}
