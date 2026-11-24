// Geometry decoding for the interactive 3D plots. The engine sends data-space
// vertices, indexed triangles and line segment endpoints. Normals are built in
// the normalized box, where the box ratios define the display-space shape.
// Vertices are shared by the indexed scene, so accumulating per source vertex
// preserves the surface's smoothness without a string-keyed position map.

import { boxMapping } from "./plot3d-maths.js";

function decodeBytes(text) {
  if (!text) return new Uint8Array(0);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeF32(text) {
  const bytes = decodeBytes(text);
  if (bytes.length % 4 !== 0) throw new Error("3D f32 buffer is not 4-byte aligned");
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function decodeU32(text) {
  const bytes = decodeBytes(text);
  if (bytes.length % 4 !== 0) throw new Error("3D u32 buffer is not 4-byte aligned");
  const view = new DataView(bytes.buffer);
  const out = new Uint32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > 1e-12)) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function freeze(group, indexed) {
  const mesh = {
    positions: new Float32Array(group.pos),
    normals: new Float32Array(group.nor),
    colors: new Uint8Array(group.col),
    count: group.pos.length / 3,
  };
  if (indexed) {
    mesh.order = new Uint32Array(mesh.count);
    for (let i = 0; i < mesh.order.length; i++) mesh.order[i] = i;
  }
  return mesh;
}

// Flat triangles from the indexed scene.
export function buildGeometry(scene) {
  const vertices = decodeF32(scene.vertices);
  const indices = decodeU32(scene.indices);
  const colors = decodeBytes(scene.colors);
  if (vertices.length % 3 !== 0) throw new Error("3D vertex buffer is not xyz-aligned");
  if (indices.length % 3 !== 0) throw new Error("3D index buffer is not triangle-aligned");
  if (colors.length % 4 !== 0) throw new Error("3D colour buffer is not rgba-aligned");
  if (!vertices.every(Number.isFinite))
    throw new Error("3D vertex buffer contains a non-finite value");
  const triangles = indices.length / 3;
  if (triangles === 0) throw new Error("3D scene has no triangles");
  if (colors.length !== triangles * 4) throw new Error("3D colour count does not match triangles");
  const vertexCount = vertices.length / 3;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) throw new Error("3D index is outside the vertex buffer");
  }
  const unitPositions = new Float32Array(vertices.length);
  const view = scene.ranges;
  const box = scene.box;
  const { scale, offset } = boxMapping(view, box);
  for (let i = 0; i < vertices.length; i += 3) {
    unitPositions[i] = vertices[i] * scale[0] + offset[0];
    unitPositions[i + 1] = vertices[i + 1] * scale[1] + offset[1];
    unitPositions[i + 2] = vertices[i + 2] * scale[2] + offset[2];
  }

  const vertexNormals = new Float32Array(vertices.length);
  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const a = [unitPositions[i0], unitPositions[i0 + 1], unitPositions[i0 + 2]];
    const b = [unitPositions[i1], unitPositions[i1 + 1], unitPositions[i1 + 2]];
    const c = [unitPositions[i2], unitPositions[i2 + 1], unitPositions[i2 + 2]];
    const normal = cross(
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    );
    for (const at of [i0, i1, i2]) {
      vertexNormals[at] += normal[0];
      vertexNormals[at + 1] += normal[1];
      vertexNormals[at + 2] += normal[2];
    }
  }
  for (let i = 0; i < vertexNormals.length; i += 3) {
    const normal = normalize([vertexNormals[i], vertexNormals[i + 1], vertexNormals[i + 2]]);
    vertexNormals[i] = normal[0];
    vertexNormals[i + 1] = normal[1];
    vertexNormals[i + 2] = normal[2];
  }

  const opaque = { pos: [], nor: [], col: [] };
  const transparent = { pos: [], nor: [], col: [] };
  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const color = colors.subarray(t * 4, t * 4 + 4);
    const target = color[3] < 255 ? transparent : opaque;
    for (const index of [i0, i1, i2]) {
      target.pos.push(vertices[index], vertices[index + 1], vertices[index + 2]);
      target.nor.push(vertexNormals[index], vertexNormals[index + 1], vertexNormals[index + 2]);
      target.col.push(color[0], color[1], color[2], color[3]);
    }
  }
  return { opaque: freeze(opaque, false), transparent: freeze(transparent, true) };
}

export function lineGeometry(scene) {
  const positions = decodeF32(scene.lines);
  if (positions.length % 3 !== 0) throw new Error("3D line buffer is not xyz-aligned");
  if (!positions.every(Number.isFinite))
    throw new Error("3D line buffer contains a non-finite value");
  const count = positions.length / 3;
  const colors = decodeBytes(scene.lineColors);
  if (colors.length !== count * 4)
    throw new Error("3D line colour count does not match line vertices");
  return {
    positions,
    normals: new Float32Array(positions.length),
    colors,
    count,
  };
}

export function lineMesh(positions, color) {
  const count = positions.length / 3;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = color[0];
    colors[i * 4 + 1] = color[1];
    colors[i * 4 + 2] = color[2];
    colors[i * 4 + 3] = 255;
  }
  return { positions, normals: new Float32Array(count * 3), colors, count };
}
