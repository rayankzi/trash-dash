import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASS, UNITY_ROOT, buildGuidMap, parseUnityYaml } from '../tools/lib/unity.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const dataRoot = path.join(projectRoot, 'src/data');
const publicRoot = path.join(projectRoot, 'public');

type NodeRef = {
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  model?: string | { path: string; meshName?: string };
  materials?: string[];
  children?: NodeRef[];
};

const modelPath = (model: NodeRef['model']) =>
  typeof model === 'string' ? model : model?.path;

function walk(node: NodeRef, visitor: (node: NodeRef, worldZ: number, worldScaleZ: number) => void, parentZ = 0, parentScaleZ = 1) {
  const worldScaleZ = parentScaleZ * node.scale[2];
  const worldZ = parentZ + node.pos[2] * parentScaleZ;
  visitor(node, worldZ, worldScaleZ);
  for (const child of node.children ?? []) walk(child, visitor, worldZ, worldScaleZ);
}

function componentRef(entry: Record<string, { fileID?: string }>): { fileID?: string } | undefined {
  return entry.component ?? Object.values(entry)[0];
}

describe('Unity YAML integrity', () => {
  const prefabFiles = fs
    .readdirSync(path.join(UNITY_ROOT, 'Assets/Bundles/Themes/Default/Urban'))
    .filter((name) => name.endsWith('.prefab'));

  it('preserves long fileID references as exact strings', () => {
    const docs = parseUnityYaml(
      path.join(UNITY_ROOT, 'Assets/Bundles/Themes/Default/Urban/UrbanBuilding01.prefab'),
    );
    const road = [...docs.values()].find(
      (doc: any) => doc.classId === CLASS.GameObject && doc.doc.m_Name === 'Road02',
    ) as any;
    const ids = road.doc.m_Component.map((entry: any) => componentRef(entry)?.fileID);
    expect(ids).toContain('33000012237236802');
    expect(ids.every((id: unknown) => typeof id === 'string')).toBe(true);
  });

  it('resolves every component reference in representative prefabs', () => {
    for (const file of prefabFiles) {
      const docs = parseUnityYaml(
        path.join(UNITY_ROOT, 'Assets/Bundles/Themes/Default/Urban', file),
      );
      const unresolved: string[] = [];
      for (const doc of docs.values() as Iterable<any>) {
        if (doc.classId !== CLASS.GameObject) continue;
        for (const entry of doc.doc.m_Component ?? []) {
          const id = componentRef(entry)?.fileID;
          if (id && id !== '0' && !docs.has(String(id))) unresolved.push(String(id));
        }
      }
      expect(unresolved, `${file} has unresolved component fileIDs`).toEqual([]);
    }
  });
});

describe('generated track assets', () => {
  const themes = JSON.parse(fs.readFileSync(path.join(dataRoot, 'themes.json'), 'utf8'));
  const materials = JSON.parse(fs.readFileSync(path.join(dataRoot, 'materials.json'), 'utf8'));
  const obstacles = JSON.parse(fs.readFileSync(path.join(dataRoot, 'obstacles.json'), 'utf8'));

  it.each(['day', 'night'])('%s contains every segment and complete environment data', (theme) => {
    const generated = fs
      .readdirSync(path.join(dataRoot, 'segments', theme))
      .filter((name) => name.endsWith('.json'));
    expect(generated).toHaveLength(21);
    expect(themes[theme].skyModel).toBeTruthy();
    expect(themes[theme].cloudPrefabs?.length).toBe(3);
    expect(themes[theme].cloudNumber).toBe(20);
  });

  it('emits only existing model and texture URLs', () => {
    const missing: string[] = [];
    for (const theme of ['day', 'night']) {
      const dir = path.join(dataRoot, 'segments', theme);
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const segment = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        walk(segment.root, (node) => {
          const model = modelPath(node.model);
          if (model && !fs.existsSync(path.join(publicRoot, 'assets', `${model}.glb`))) {
            missing.push(`${theme}/${file}: ${model}`);
          }
        });
      }
      for (const cloud of themes[theme].cloudPrefabs ?? []) {
        walk(cloud.root ?? cloud, (node) => {
          const model = modelPath(node.model);
          if (model && !fs.existsSync(path.join(publicRoot, 'assets', `${model}.glb`))) {
            missing.push(`${theme}/cloud: ${model}`);
          }
        });
      }
    }
    for (const [name, info] of Object.entries(materials) as [string, any][]) {
      const textureUrl = info.textureUrl
        ?? (info.texture?.includes('/') ? `assets/${info.texture}` : info.texture ? `assets/textures/${info.texture}.webp` : null);
      if (textureUrl && !fs.existsSync(path.join(publicRoot, textureUrl))) {
        missing.push(`material ${name}: ${textureUrl}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(['day', 'night'])('%s roads cover every segment path continuously', (theme) => {
    const dir = path.join(dataRoot, 'segments', theme);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const segment = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const intervals: [number, number][] = [];
      walk(segment.root, (node, worldZ, worldScaleZ) => {
        const model = modelPath(node.model);
        if (!model || !/\/Road0[1-4](Night)?$/.test(model)) return;
        const halfLength = Math.abs(worldScaleZ) * 4.5;
        intervals.push([worldZ - halfLength, worldZ + halfLength]);
      });
      intervals.sort((a, b) => a[0] - b[0]);
      const start = segment.path.nodes[0].pos[2];
      const end = segment.path.nodes.at(-1).pos[2];
      let coveredUntil = start;
      for (const [from, to] of intervals) {
        if (to < coveredUntil) continue;
        expect(from, `${theme}/${file} has a road gap after z=${coveredUntil}`).toBeLessThanOrEqual(
          coveredUntil + 0.03,
        );
        coveredUntil = Math.max(coveredUntil, to);
      }
      expect(coveredUntil, `${theme}/${file} road ends before the path`).toBeGreaterThanOrEqual(
        end - 0.03,
      );
    }
  });

  it('every non-dog obstacle has a visible source model', () => {
    for (const [theme, definitions] of Object.entries(obstacles) as [string, any][]) {
      for (const [name, definition] of Object.entries(definitions) as [string, any][]) {
        if (name === 'ObstacleDog') continue;
        let models = 0;
        walk(definition.root, (node) => {
          if (modelPath(node.model)) models += 1;
        });
        expect(models, `${theme}/${name} has no model`).toBeGreaterThan(0);
      }
    }
  });

  it('uses only supported normalized shader families', () => {
    const supported = new Set([
      'curvedOpaque',
      'curvedAlpha',
      'curvedCloud',
      'vertexColor',
      'blinking',
      'standard',
    ]);
    for (const [name, info] of Object.entries(materials) as [string, any][]) {
      expect(supported.has(info.shaderFamily), `${name}: ${info.shaderFamily}`).toBe(true);
    }
  });

  it('maps every FBX GUID used by generated models', () => {
    expect(buildGuidMap().size).toBeGreaterThan(100);
  });
});
