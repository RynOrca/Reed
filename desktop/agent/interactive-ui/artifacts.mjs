import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDocument, validateState } from './protocol.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = value => { if (typeof value !== 'string' || !ID.test(value)) throw new Error('作品或会话 ID 无效'); return value; };

export class InteractiveArtifactStore {
  constructor(dataDir) { this.root = join(dataDir, 'artifacts', 'interactive'); }
  path(sessionId, artifactId) { return join(this.root, validId(sessionId), `${validId(artifactId)}.json`); }
  async create(sessionId, document, { parentArtifactId = null } = {}) {
    validId(sessionId);
    if (parentArtifactId) {
      const parent = await this.read(sessionId, parentArtifactId);
      if (!parent) throw new Error('父作品不存在');
    }
    validateDocument(document);
    const artifactId = randomUUID();
    const artifact = { artifactId, sessionId, parentArtifactId, createdAt: new Date().toISOString(), document, state: document.mode === 'fixture' ? { step: 0 } : { ...document.initialState } };
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
      if (artifact.sessionId !== sessionId || artifact.artifactId !== artifactId) throw new Error('作品文件格式无效');
      validateDocument(artifact.document);
      if (!validateState(artifact.document, artifact.state)) {
        artifact.state = artifact.document.mode === 'fixture' ? { step: 0 } : { ...artifact.document.initialState };
        artifact.stateWarning = '已保存的操作状态无效，已回到初始状态。';
      }
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
    if (!validateState(artifact.document, state)) throw new Error('作品状态无效');
    artifact.state = { ...state };
    delete artifact.stateWarning;
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
