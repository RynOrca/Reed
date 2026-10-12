import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = value => { if (typeof value !== 'string' || !ID.test(value)) throw new Error('作品或会话 ID 无效'); return value; };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export class InteractiveArtifactStore {
  constructor(dataDir) { this.root = join(dataDir, 'artifacts', 'interactive'); }
  path(sessionId, artifactId) { return join(this.root, validId(sessionId), `${validId(artifactId)}.json`); }
  async create(sessionId, document, { parentArtifactId = null } = {}) {
    validId(sessionId);
    if (parentArtifactId) {
      const parent = await this.read(sessionId, parentArtifactId);
      if (!parent) throw new Error('父作品不存在');
    }
    if (!document || document.schemaVersion !== 1 || document.mode !== 'fixture' ||
      typeof document.title !== 'string' || !document.title.trim() || document.title.length > 120 ||
      !Array.isArray(document.steps) || document.steps.length < 2 || document.steps.length > 16 ||
      document.steps.some(step => !step || typeof step.title !== 'string' || typeof step.body !== 'string' || step.title.length > 120 || step.body.length > 1000)) {
      throw new Error('固定测试作品格式无效');
    }
    const artifactId = randomUUID();
    const artifact = { artifactId, sessionId, parentArtifactId, createdAt: new Date().toISOString(), document, state: { step: 0 } };
    await mkdir(join(this.root, sessionId), { recursive: true });
    await this.write(sessionId, artifactId, artifact);
    return artifact;
  }
  async write(sessionId, artifactId, artifact) {
    const path = this.path(sessionId, artifactId);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(artifact)); await rename(temp, path); }
    catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
  }
  async read(sessionId, artifactId) {
    try {
      const artifact = JSON.parse(await readFile(this.path(sessionId, artifactId), 'utf8'));
      if (artifact.sessionId !== sessionId || artifact.artifactId !== artifactId || artifact.document?.schemaVersion !== 1 || artifact.document?.mode !== 'fixture') throw new Error('作品文件格式无效');
      return artifact;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async summary(sessionId, artifactId) {
    const artifact = await this.read(sessionId, artifactId);
    return artifact ? { artifactId, title: artifact.document.title, parentArtifactId: artifact.parentArtifactId, createdAt: artifact.createdAt, status: 'available' }
      : { artifactId, title: '交互讲解作品', status: 'missing' };
  }
  async saveState(sessionId, artifactId, state) {
    const artifact = await this.read(sessionId, artifactId);
    if (!artifact) throw new Error('作品文件不可用');
    if (!state || Object.keys(state).length !== 1 || !own(state, 'step') || !Number.isInteger(state.step) || state.step < 0 || state.step >= artifact.document.steps.length) throw new Error('作品状态无效');
    artifact.state = { step: state.step };
    await this.write(sessionId, artifactId, artifact);
    return artifact.state;
  }
  async deleteSession(sessionId) {
    validId(sessionId);
    const dir = join(this.root, sessionId);
    const info = await stat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isDirectory()) await rm(dir, { recursive: true, force: true });
  }
}

export function boundArtifactIds(branch) {
  const messageIds = new Set(branch.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant').map(entry => entry.id));
  return new Set(branch.filter(entry => entry.type === 'custom' && entry.customType === 'reed_interactive_artifact' && messageIds.has(entry.data?.messageEntryId))
    .map(entry => entry.data?.artifactId).filter(id => typeof id === 'string' && ID.test(id)));
}
