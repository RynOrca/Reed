import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";

export function searchTokens(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase();
  const english = normalized.match(/[a-z0-9]+/g) || [];
  const chinese = (normalized.match(/[\p{Script=Han}]+/gu) || []).flatMap(part =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)));
  return [...new Set([...english, ...chinese])];
}

function tokens(value) { return searchTokens(value); }
// "abc:" prefixes every id of one file, so the exclusive upper bound stays inside
// the same index range without scanning the whole metadata table.
function prefixBounds(prefix) {
  if (!prefix) return ["", "\uffff"];
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`];
}

const RETAIN_PAGE = 2000;

// A chunk whose whole text is its own heading line (or a separator) inherits the
// heading in the indexed text and used to outrank real content under plain bm25.
function headingOnly(payload) {
  const content = String(payload?.content ?? "").replace(/^#+\s*/, "").trim();
  const heading = String(payload?.heading ?? "").trim();
  return Boolean(content) && content === heading;
}

/**
 * Deterministic rerank of bm25 candidates.
 *
 * bm25 rewards short documents, so a one-line separator or a heading-only chunk
 * scores far above the paragraph that actually answers the query. Hits are grouped
 * by what they really matched — own content, then labels only, then a chunk that is
 * nothing but its heading — and scored by coverage inside the group.
 */
export function rankHits(rows, words) {
  const total = Math.max(1, words.length);
  const scored = rows.map((row, index) => {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = {}; }
    const content = String(payload?.content ?? "").toLowerCase();
    const labels = `${payload?.heading ?? ""} ${payload?.title ?? ""}`.toLowerCase();
    const compact = content.replace(/\s+/g, "");
    const contentHits = words.filter(word => content.includes(word)).length;
    const labelHits = words.filter(word => labels.includes(word)).length;
    const phrase = compact.includes(words.join("")) ? 1 : 0;
    const onlyHeading = headingOnly(payload);
    // Long chunks are slightly discounted, but the penalty never outweighs coverage.
    const lengthPenalty = Math.min(0.12, content.length / 60000);
    const score = (contentHits / total) * 0.62 + (labelHits / total) * 0.22 + phrase * 0.16 - lengthPenalty;
    const tier = onlyHeading ? 2 : contentHits > 0 ? 0 : 1;
    return { row, payload, index, contentHits, labelHits, onlyHeading, tier, score: Math.max(0, Math.min(1, score)) };
  });
  return scored
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index)
    .map(item => ({
      id: item.row.id,
      area: item.row.area,
      scope: item.row.scope,
      revision: item.row.revision,
      text: item.row.text,
      payload: item.payload,
      score: Number(item.score.toFixed(4)),
      bm25: -item.row.rank,
      contentHits: item.contentHits,
      headingOnly: item.onlyHeading,
    }));
}

export class LocalSearchIndex {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
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
    // FTS UNINDEXED columns cannot have B-tree indexes. Looking up each file/id
    // in that virtual table made indexing quadratic and blocked cancellation.
    this.#migrateMetadata();
    this.closed = false;
    this.find = this.db.prepare("SELECT document_rowid AS rowid, revision FROM search_metadata WHERE area = ? AND scope = ? AND id = ? LIMIT 1");
    this.insert = this.db.prepare("INSERT INTO search_documents (id, area, scope, revision, tokens, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.update = this.db.prepare("UPDATE search_documents SET revision = ?, tokens = ?, text = ?, payload = ? WHERE rowid = ?");
    this.removeRow = this.db.prepare("DELETE FROM search_documents WHERE rowid = ?");
    this.writeMetadata=this.db.prepare('INSERT OR REPLACE INTO search_metadata VALUES(?,?,?,?,?)');
    this.removeMetadata=this.db.prepare('DELETE FROM search_metadata WHERE document_rowid=?');
    this.listPrefix = this.db.prepare("SELECT id, revision FROM search_metadata WHERE area = ? AND scope = ? AND id >= ? AND id < ?");
    // Paging walks the primary key; filtering area/scope in SQL made every page
    // scan and sort the whole table through the lookup index.
    this.listPage = this.db.prepare("SELECT document_rowid AS rowid, area, scope, id FROM search_metadata WHERE document_rowid > ? ORDER BY document_rowid LIMIT ?");
  }

  /**
   * Create or repair the ordinary metadata table inside one transaction.
   *
   * Metadata rowids are what `find`, `list` and `retain` trust, so a partial
   * backfill after a crash must never look "already migrated". The row counts are
   * verified on every open (the index stays open for the whole session, so this
   * costs one check per start) and any mismatch rebuilds the table from the FTS
   * documents, dropping duplicates and orphans left by an interrupted migration.
   */
  #migrateMetadata() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS search_metadata (
        document_rowid INTEGER PRIMARY KEY, area TEXT, scope TEXT, id TEXT, revision TEXT
      );
      CREATE INDEX IF NOT EXISTS search_metadata_lookup ON search_metadata(area, scope, id);`);
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
      const documents = Number(this.db.prepare('SELECT count(*) AS n FROM search_documents').get()?.n || 0);
      const metadata = Number(this.db.prepare('SELECT count(*) AS n FROM search_metadata').get()?.n || 0);
      if (version < 1 || documents !== metadata) {
        // Rebuild from the FTS table, keeping the newest row per (area, scope, id).
        const rows = this.db.prepare('SELECT rowid, area, scope, id, revision FROM search_documents ORDER BY rowid ASC').all();
        const keep = new Map();
        for (const row of rows) keep.set(`${row.area}\u0000${row.scope}\u0000${row.id}`, row);
        const write = this.db.prepare('INSERT OR REPLACE INTO search_metadata VALUES(?,?,?,?,?)');
        const drop = this.db.prepare('DELETE FROM search_documents WHERE rowid = ?');
        this.db.exec('DELETE FROM search_metadata');
        for (const row of rows) {
          const newest = keep.get(`${row.area}\u0000${row.scope}\u0000${row.id}`);
          if (newest.rowid === row.rowid) write.run(row.rowid, row.area, row.scope, row.id, row.revision);
          else drop.run(row.rowid);
        }
        this.db.exec('PRAGMA user_version = 1');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
    // A savepoint is also safe inside a caller's batching transaction.
    this.db.exec('SAVEPOINT search_put');
    try{
      let rowid=previous?.rowid;
      if (previous) this.update.run(revision, indexed, text, encoded, rowid);
      else rowid=this.insert.run(id, area, scope, revision, indexed, text, encoded).lastInsertRowid;
      this.writeMetadata.run(rowid,area,scope,id,revision);
      this.db.exec('RELEASE search_put');
    }catch(error){this.db.exec('ROLLBACK TO search_put; RELEASE search_put');throw error;}
    return true;
  }

  remove(area, id) {
    this.#assertOpen();
    const rows = this.db.prepare("SELECT document_rowid AS rowid FROM search_metadata WHERE area = ? AND id = ?").all(area, id);
    this.transaction(()=>{for (const row of rows) {this.removeRow.run(row.rowid);this.removeMetadata.run(row.rowid);}});
    return rows.length;
  }

  retain(area, scope, ids) {
    this.#assertOpen();
    const keep = new Set(ids);
    const rows = this.db.prepare("SELECT document_rowid AS rowid, id FROM search_metadata WHERE area = ? AND scope = ?").all(area, scope);
    let removed = 0;
    this.transaction(()=>{for (const row of rows) if (!keep.has(row.id)) { this.removeRow.run(row.rowid);this.removeMetadata.run(row.rowid); removed++; }});
    return removed;
  }

  /**
   * Delete stale documents a page at a time and give the event loop back between
   * pages: one huge synchronous transaction stalled cancellation on large vaults.
   */
  async retainPaged(area, scope, ids, { page = RETAIN_PAGE } = {}) {
    this.#assertOpen();
    const keep = new Set(ids);
    let cursor = -1, removed = 0;
    for (;;) {
      const rows = this.listPage.all(cursor, page);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].rowid;
      const stale = rows.filter(row => row.area === area && row.scope === scope && !keep.has(row.id));
      if (stale.length) this.transaction(()=>{for (const row of stale) { this.removeRow.run(row.rowid); this.removeMetadata.run(row.rowid); removed++; }});
      await yieldLoop();
    }
    return removed;
  }

  list(area, scope, idPrefix = "") {
    this.#assertOpen();
    const [lower, upper] = prefixBounds(idPrefix);
    return this.listPrefix.all(area, scope, lower, upper).map(({ id, revision }) => ({ id, revision }));
  }

  transaction(operation) {
    this.#assertOpen();this.db.exec('BEGIN');
    try{const result=operation();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
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
    return rankHits(rows, words).map(row => ({
      id: row.id,
      area: row.area,
      scope: row.scope,
      revision: row.revision,
      text: row.text,
      payload: row.payload,
      score: row.score,
      bm25: row.bm25,
    }));
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
