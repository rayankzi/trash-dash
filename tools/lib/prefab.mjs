// Unity prefab -> runtime PrefabNode extraction shared by segment and theme tools.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CLASS,
  UNITY_ROOT,
  assertResolvableComponentRefs,
  fileID,
  parseUnityYaml,
  prefabInstanceParent,
  prefabInstanceTransform,
  quat,
  vec3,
} from './unity.mjs';

export function assetName(assetPath) {
  return assetPath ? path.basename(assetPath, path.extname(assetPath)) : null;
}

export function modelPath(assetPath) {
  if (!assetPath || !/\.fbx$/i.test(assetPath)) return null;
  return assetPath.startsWith('Assets/Animation/')
    ? path.join('anim', path.basename(assetPath)).replace(/\.fbx$/i, '')
    : path.join('models', path.relative('Assets/Models', assetPath)).replace(/\.fbx$/i, '');
}

const meshNamesByAsset = new Map();
function isLfsPointer(assetPath) {
  const file = path.join(UNITY_ROOT, assetPath);
  if (statSync(file).size > 1024) return false;
  return readFileSync(file, 'utf8').startsWith('version https://git-lfs.github.com/spec/v1');
}

function meshName(assetPath, meshID) {
  let names = meshNamesByAsset.get(assetPath);
  if (!names) {
    names = new Map();
    const meta = readFileSync(path.join(UNITY_ROOT, `${assetPath}.meta`), 'utf8');
    for (const match of meta.matchAll(/^    (-?\d+):\s*(.+)$/gm)) {
      names.set(match[1], match[2].trim());
    }
    meshNamesByAsset.set(assetPath, names);
  }
  return names.get(meshID) ?? null;
}

/**
 * Build the visual node tree of a prefab while preserving exact Unity mesh and
 * renderer metadata. `onNestedPrefab` is called for source prefabs referenced
 * by PrefabInstance nodes so callers can build a shared-prop manifest.
 */
export function parsePrefab(filePath, guidMap, { onNestedPrefab } = {}) {
  const docs = parseUnityYaml(filePath);
  assertResolvableComponentRefs(docs, filePath);

  const instancesByParent = new Map();
  for (const [id, entry] of docs) {
    if (entry.classId !== CLASS.PrefabInstance || entry.stripped) continue;
    const parent = prefabInstanceParent(entry.doc);
    if (!instancesByParent.has(parent)) instancesByParent.set(parent, []);
    instancesByParent.get(parent).push({ fileID: id, doc: entry.doc });
  }

  const componentOf = (gameObject, wantedClassId) => {
    for (const component of gameObject.m_Component ?? []) {
      const ref = component.component ?? Object.values(component)[0];
      const id = fileID(ref);
      if (!id || id === '0') continue;
      const entry = docs.get(id);
      if (!entry) {
        throw new Error(`Unresolved component ${id} in ${filePath}`);
      }
      if (entry.classId === wantedClassId) return entry.doc;
    }
    return null;
  };

  const materialName = (ref) => {
    const id = fileID(ref);
    if (!id || id === '0') return null;
    const assetPath = ref.guid && guidMap.get(ref.guid);
    if (!assetPath) {
      throw new Error(`Unresolved material reference ${ref.guid ?? '<built-in>'}:${id} in ${filePath}`);
    }
    return assetName(assetPath);
  };

  function buildNode(transformID) {
    const id = typeof transformID === 'string' ? transformID : fileID(transformID);
    const transform = id && docs.get(id);
    if (!transform || transform.classId !== CLASS.Transform || transform.stripped) return null;

    const gameObjectID = fileID(transform.doc.m_GameObject);
    const gameObject = gameObjectID && docs.get(gameObjectID);
    if (!gameObject) throw new Error(`Unresolved GameObject ${gameObjectID} for Transform ${id} in ${filePath}`);
    if (gameObject.doc.m_IsActive === 0) return null;

    const node = {
      name: gameObject.doc.m_Name ?? '',
      pos: vec3(transform.doc.m_LocalPosition),
      rot: quat(transform.doc.m_LocalRotation),
      scale: vec3(transform.doc.m_LocalScale),
    };

    const skinned = componentOf(gameObject.doc, CLASS.SkinnedMeshRenderer);
    const meshRenderer = componentOf(gameObject.doc, CLASS.MeshRenderer);
    const renderer = skinned ?? meshRenderer;
    const meshRef = componentOf(gameObject.doc, CLASS.MeshFilter)?.m_Mesh ?? skinned?.m_Mesh;
    const meshID = fileID(meshRef);
    if (meshRef?.guid && meshID && meshID !== '0') {
      const meshAsset = guidMap.get(meshRef.guid);
      if (!meshAsset) {
        throw new Error(`Unresolved mesh GUID ${meshRef.guid}:${meshID} in ${filePath}`);
      }
      const subassetName = meshName(meshAsset, meshID);
      if (!subassetName) {
        throw new Error(`Unresolved FBX mesh subasset ${meshRef.guid}:${meshID} in ${filePath}`);
      }
      node.mesh = { guid: meshRef.guid, fileID: meshID, name: subassetName, asset: meshAsset };
      const runtimeModel = modelPath(meshAsset);
      // Keep mesh identity for diagnostics/proxies, but do not emit a URL that
      // cannot exist while Git LFS only has a pointer. Regeneration starts
      // emitting the original model automatically once the binary is fetched.
      if (runtimeModel && !isLfsPointer(meshAsset)) node.model = runtimeModel;
    }
    if (renderer) {
      node.rendererEnabled = renderer.m_Enabled !== 0;
      if (renderer.m_Materials) {
        const slots = renderer.m_Materials.map(materialName);
        if (slots.some((slot) => slot === null)) {
          throw new Error(`Empty material slot on ${node.name} in ${filePath}`);
        }
        node.materials = slots;
      }
    }

    const children = [];
    for (const child of transform.doc.m_Children ?? []) {
      const built = buildNode(fileID(child));
      if (built) children.push(built);
    }
    for (const instance of instancesByParent.get(id) ?? []) {
      const sourceGuid = instance.doc.m_SourcePrefab?.guid;
      const sourcePath = sourceGuid && guidMap.get(sourceGuid);
      if (!sourcePath || !sourcePath.endsWith('.prefab')) {
        throw new Error(`Unresolved nested prefab ${sourceGuid ?? '<missing-guid>'} in ${filePath}`);
      }
      onNestedPrefab?.(sourcePath);
      children.push({
        name: path.basename(sourcePath, '.prefab'),
        prefab: path.basename(sourcePath, '.prefab'),
        ...prefabInstanceTransform(instance.doc),
      });
    }
    if (children.length) node.children = children;
    return node;
  }

  let root = null;
  for (const [id, entry] of docs) {
    if (
      entry.classId === CLASS.Transform &&
      !entry.stripped &&
      (fileID(entry.doc.m_Father) ?? '0') === '0'
    ) {
      root = buildNode(id);
      break;
    }
  }

  const monoBehaviours = [...docs.values()].filter(
    (entry) => entry.classId === CLASS.MonoBehaviour && !entry.stripped
  );
  return { docs, root, monoBehaviours };
}
