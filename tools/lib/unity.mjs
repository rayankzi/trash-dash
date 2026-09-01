// Utilities for reading Unity YAML assets (.prefab, .asset, .meta) without the Unity editor.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { load } from 'js-yaml';

const defaultUnityRoot = path.resolve(import.meta.dirname, '../../../EndlessRunnerSampleGame');
export const UNITY_ROOT = process.env.UNITY_SOURCE_DIR
  ? path.resolve(process.cwd(), process.env.UNITY_SOURCE_DIR)
  : defaultUnityRoot;

if (!existsSync(path.join(UNITY_ROOT, 'Assets'))) {
  throw new Error(
    `Unity source project not found at ${UNITY_ROOT}. Set UNITY_SOURCE_DIR to a Unity project containing Assets/.`
  );
}

// Unity class IDs we care about
export const CLASS = {
  GameObject: 1,
  Transform: 4,
  MeshRenderer: 23,
  MeshFilter: 33,
  MonoBehaviour: 114,
  SkinnedMeshRenderer: 137,
  PrefabInstance: 1001,
};

/**
 * Build a map of GUID -> asset path (relative to unity project root) by scanning .meta files.
 * The guid always appears as a top-level `guid: <hex>` line; a regex read is far cheaper
 * than YAML-parsing thousands of meta files.
 */
export function buildGuidMap() {
  const metas = fg.sync('Assets/**/*.meta', { cwd: UNITY_ROOT });
  const map = new Map();
  for (const meta of metas) {
    const text = readFileSync(path.join(UNITY_ROOT, meta), 'utf8');
    const m = text.match(/^guid: ([0-9a-f]{32})$/m);
    if (m) map.set(m[1], meta.slice(0, -'.meta'.length));
  }
  return map;
}

/**
 * Parse a Unity YAML file (multi-document with !u! tags) into a Map of
 * fileID -> { classId, stripped, type, doc } where `doc` is the parsed body
 * (e.g. the object under the "Transform:" key) and `type` is that key name.
 */
export function parseUnityYaml(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const docs = new Map();
  const headerRe = /^--- !u!(\d+) &(-?\d+)( stripped)?$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ classId: Number(m[1]), fileID: m[2], stripped: !!m[3], bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const end = i + 1 < headers.length ? text.lastIndexOf('--- !u!', headers[i + 1].bodyStart) : text.length;
    // Unity fileIDs routinely exceed Number.MAX_SAFE_INTEGER. Quote every fileID
    // scalar before YAML parsing so references remain byte-for-byte strings and
    // can still match the string IDs captured from document headers.
    const body = text
      .slice(h.bodyStart, end)
      .replace(/(\bfileID:\s*)(-?\d+)(?=\s*(?:[,}\r\n]))/g, '$1"$2"');
    let parsed;
    try {
      parsed = load(body);
    } catch {
      // Some legacy UI text in .unity scenes is not accepted by js-yaml.
      // Prefab extraction still fails later if a skipped document is referenced
      // as a component, via assertResolvableComponentRefs().
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const type = Object.keys(parsed)[0];
    docs.set(h.fileID, { classId: h.classId, stripped: h.stripped, type, doc: parsed[type] });
  }
  return docs;
}

/** Return an exact Unity fileID string without ever round-tripping through Number. */
export function fileID(ref) {
  const value = ref?.fileID;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`Unity fileID was parsed as ${typeof value}; exact string parsing is required`);
  }
  return value;
}

/**
 * Fail fast when a GameObject's serialized component list points at a missing
 * YAML document. Previously these misses were silently ignored, which removed
 * meshes whose 17+ digit component IDs had been rounded by JavaScript.
 */
export function assertResolvableComponentRefs(docs, filePath) {
  const unresolved = [];
  for (const [gameObjectID, entry] of docs) {
    if (entry.classId !== CLASS.GameObject) continue;
    for (const component of entry.doc.m_Component ?? []) {
      const ref = component.component ?? Object.values(component)[0];
      const id = fileID(ref);
      if (id && id !== '0' && !docs.has(id)) unresolved.push(`${gameObjectID} -> ${id}`);
    }
  }
  if (unresolved.length) {
    throw new Error(
      `Unresolved Unity component references in ${filePath}:\n${unresolved.map((r) => `  ${r}`).join('\n')}`
    );
  }
}

/** Extract {x,y,z(,w)} object to plain array. */
export const vec3 = (v) => [v?.x ?? 0, v?.y ?? 0, v?.z ?? 0];
export const quat = (v) => [v?.x ?? 0, v?.y ?? 0, v?.z ?? 0, v?.w ?? 1];

/** Read a PrefabInstance's transform overrides from m_Modifications. */
export function prefabInstanceTransform(doc) {
  const mods = doc?.m_Modification?.m_Modifications ?? [];
  const pos = [0, 0, 0];
  const rot = [0, 0, 0, 1];
  const scale = [1, 1, 1];
  const axes = { x: 0, y: 1, z: 2, w: 3 };
  for (const mod of mods) {
    const p = mod.propertyPath;
    const value = Number(mod.value);
    if (typeof p !== 'string' || Number.isNaN(value)) continue;
    if (p.startsWith('m_LocalPosition.')) pos[axes[p.slice(-1)]] = value;
    else if (p.startsWith('m_LocalRotation.')) rot[axes[p.slice(-1)]] = value;
    else if (p.startsWith('m_LocalScale.')) scale[axes[p.slice(-1)]] = value;
  }
  return { pos, rot, scale };
}

/** Name override (m_Name) from a PrefabInstance's modifications, if present. */
export function prefabInstanceName(doc) {
  const mods = doc?.m_Modification?.m_Modifications ?? [];
  return mods.find((mod) => mod.propertyPath === 'm_Name')?.value;
}

/** Find the parent transform fileID a PrefabInstance is attached under. */
export function prefabInstanceParent(doc) {
  return fileID(doc?.m_Modification?.m_TransformParent) ?? '0';
}
