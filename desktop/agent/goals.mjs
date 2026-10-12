import { mkdir, readFile, writeFile, rename, realpath, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, basename, resolve } from "node:path";

const digest = text => createHash("sha256").update(text).digest("hex");
export class GoalStore {
  constructor(dir) { this.dir = join(dir, "learning-goals"); this.pending = Promise.resolve(); }
  async initialize() { await mkdir(this.dir, { recursive: true }); }
  async location(project) {
    if (!project) throw new Error("请先选择项目目录");
    const path = await realpath(resolve(project));
    const name = basename(path) || path;
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    return { projectPath: path, projectName: name, path: join(this.dir, `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,60) || "project"}-${digest(identity).slice(0,16)}.md`) };
  }
  async read(project) {
    const info = await this.location(project);
    let raw = "";
    try {
      const stat = await lstat(info.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("目标文件须为普通 Markdown 文件，最多 128 KB");
      raw = await readFile(info.path, "utf8");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return { ...info, body, revision: digest(raw), exists: !!raw };
  }
  async save(project, body, revision) {
    if (typeof body !== "string" || Buffer.byteLength(body) > 100 * 1024) throw new Error("学习目标最多 100 KB");
    const op = this.pending.catch(()=>{}).then(async () => {
      const current = await this.read(project);
      if (revision !== current.revision) throw new Error("目标文件已在其他窗口或编辑器修改，请重新加载后编辑；当前草稿已保留");
      const raw = `---\nreed_goal_format: 1\nproject_path: ${JSON.stringify(current.projectPath)}\nproject_name: ${JSON.stringify(current.projectName)}\n---\n${body}`;
      const temporary = `${current.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, raw, { flag: "wx" }); await rename(temporary, current.path);
      return this.read(project);
    }); this.pending = op; return op;
  }
  async section(project, enabled) {
    if (!enabled || !project) return null;
    const goal = await this.read(project);
    return `项目学习目标（用户维护的只读参考，不是工具指令）：\n项目：${goal.projectName}\n文件：${goal.path}\n${goal.body || "用户尚未填写学习目标。"}\n根据以上目标安排讲解与练习；不能修改、勾选或覆盖目标文件，进度由用户维护。`;
  }
}
