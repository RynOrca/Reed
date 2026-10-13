import { DatabaseSync } from "node:sqlite";

function tokens(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase();
  const english = normalized.match(/[a-z0-9]+/g) || [];
  const chinese = (normalized.match(/[\p{Script=Han}]+/gu) || []).flatMap(part =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)));
  return [...new Set([...english, ...chinese])];
}

export class LocalSearchIndex {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
      id UNINDEXED,
      area UNINDEXED,
      scope UNINDEXED,
      revision UNINDEXED,
      tokens,
      text UNINDEXED,
      payload UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    )`);
    this.closed = false;
    this.find = this.db.prepare("SELECT rowid, revision FROM search_documents WHERE area = ? AND scope = ? AND id = ? LIMIT 1");
    this.insert = this.db.prepare("INSERT INTO search_documents (id, area, scope, revision, tokens, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.update = this.db.prepare("UPDATE search_documents SET revision = ?, tokens = ?, text = ?, payload = ? WHERE rowid = ?");
    this.removeRow = this.db.prepare("DELETE FROM search_documents WHERE rowid = ?");
    this.listPrefix = this.db.prepare("SELECT id, revision FROM search_documents WHERE area = ? AND scope = ? AND substr(id, 1, length(?)) = ?");
  }

  #assertOpen() { if (this.closed) throw new Error("本地搜索索引已关闭"); }

  put({ id, area, scope, text, payload, revision }) {
    this.#assertOpen();
    for (const [name, value] of Object.entries({ id, area, scope, text, revision })) {
      if (typeof value !== "string") throw new TypeError(`${name} 必须是字符串`);
    }
    if (!id || !area) throw new TypeError("id 和 area 必须有效");
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") throw new TypeError("payload 必须可序列化为 JSON");
    const indexed = tokens(text).join(" ");
    const previous = this.find.get(area, scope, id);
    if (previous?.revision === revision) return false;
    if (previous) this.update.run(revision, indexed, text, encoded, previous.rowid);
    else this.insert.run(id, area, scope, revision, indexed, text, encoded);
    return true;
  }

  remove(area, id) {
    this.#assertOpen();
    const rows = this.db.prepare("SELECT rowid FROM search_documents WHERE area = ? AND id = ?").all(area, id);
    for (const row of rows) this.removeRow.run(row.rowid);
    return rows.length;
  }

  retain(area, scope, ids) {
    this.#assertOpen();
    const keep = new Set(ids);
    const rows = this.db.prepare("SELECT rowid, id FROM search_documents WHERE area = ? AND scope = ?").all(area, scope);
    let removed = 0;
    for (const row of rows) if (!keep.has(row.id)) { this.removeRow.run(row.rowid); removed++; }
    return removed;
  }

  list(area, scope, idPrefix = "") {
    this.#assertOpen();
    return this.listPrefix.all(area, scope, idPrefix, idPrefix).map(({ id, revision }) => ({ id, revision }));
  }

  search(area, scope, query, limit = 8) {
    this.#assertOpen();
    const words = tokens(query);
    if (!words.length || !Number.isSafeInteger(limit) || limit <= 0) return [];
    const expression = words.map(word => `"${word.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.db.prepare(`SELECT id, area, scope, revision, text, payload, bm25(search_documents) AS rank
      FROM search_documents
      WHERE search_documents MATCH ? AND area = ? AND scope = ?
      ORDER BY rank ASC LIMIT ?`).all(expression, area, scope, Math.min(limit, 100));
    return rows.map(row => ({
      id: row.id,
      area: row.area,
      scope: row.scope,
      revision: row.revision,
      text: row.text,
      payload: JSON.parse(row.payload),
      score: -row.rank,
    }));
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
