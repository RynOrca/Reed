// 版本号与「关于 → 检查更新」。
//
// 两条路径，由**一个**来源决定：tauri.conf.json 的 plugins.updater.pubkey。
//   - 配了公钥 → Tauri 官方 updater：检查 → 下载 → 验签 → 安装 → 重启，即一键更新。
//   - 没配公钥 → 只比对版本并跳转下载页，不下载不安装。
//
// 公钥只在 tauri.conf.json 里存一份。前端不复制它，而是问 Rust「配了吗」
// （update_key_configured），避免两处配置漂移成「说有新版、装却签名不对」。
//
// 公钥缺失时**绝不**退回静默安装：那等于跳过验签，任何人都能塞一个包进来。

const RELEASE_PAGE = "https://github.com/RynOrca/Reed/releases/latest";
const RELEASE_API = "https://api.github.com/repos/RynOrca/Reed/releases/latest";
const CHECK_TIMEOUT_MS = 20000;

let cachedVersion = null;
let cachedKeyConfigured = null;

/** 读取应用版本号（来自构建时的 tauri.conf.json）。读不到就返回 null，不猜。 */
export async function appVersion(tauri = globalThis.__TAURI__) {
  if (cachedVersion) return cachedVersion;
  try { cachedVersion = String(await tauri.core.invoke("app_version")); }
  catch { cachedVersion = null; }
  return cachedVersion;
}

/** 构建时是否配了更新公钥。未知时按「没配」处理，宁可提示手动下载也不假装能装。 */
export async function updaterConfigured(tauri = globalThis.__TAURI__) {
  if (cachedKeyConfigured !== null) return cachedKeyConfigured;
  try { cachedKeyConfigured = (await tauri.core.invoke("update_key_configured")) === true; }
  catch { cachedKeyConfigured = false; }
  return cachedKeyConfigured;
}

/** 把版本号填进启动动画（元素不存在时静默跳过，设置页没有这个元素）。 */
export async function showStartupVersion(tauri) {
  const slot = document.getElementById("startup-version");
  if (!slot) return;
  const version = await appVersion(tauri);
  if (version) slot.textContent = `版本 ${version}`;
}

/** 比较 a 是否比 b 新。只认数字段，遇到预发布后缀（-beta）按更低处理。 */
export function isNewer(a, b) {
  const parse = value => String(value || "").trim().replace(/^v/i, "").split("-")[0].split(".").map(part => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const left = parse(a), right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] || 0, y = right[i] || 0;
    if (x !== y) return x > y;
  }
  // 数字段相同：带预发布后缀的更旧
  const preA = String(a || "").includes("-"), preB = String(b || "").includes("-");
  return preB && !preA;
}

/**
 * 检查更新。返回 {status, current, latest?, update?, reason?}
 *   status: 'available' 有新版（且可一键安装） | 'available-manual' 有新版但需手动下载
 *           'current' 已是最新 | 'unsupported' 当前环境无法检查 | 'error' 检查失败
 * update 只在 'available' 时存在，交给 installUpdate 使用。
 */
export async function checkForUpdate(tauri = globalThis.__TAURI__) {
  const current = await appVersion(tauri);
  if (!current) return { status: "unsupported", reason: "无法读取当前版本号" };

  // 路径 1：官方 updater（构建时已配公钥）
  if (await updaterConfigured(tauri)) {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return { status: "current", current };
      return { status: "available", current, latest: update.version, update, notes: update.body || "" };
    } catch (error) {
      return { status: "error", current, reason: humanize(error) };
    }
  }

  // 路径 2：仅比对版本，跳转下载页
  try {
    const response = await fetch(RELEASE_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "error", current, reason: `发布信息不可用（HTTP ${response.status}）` };
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    if (latest && isNewer(latest, current)) return { status: "available-manual", current, latest, notes: release.body || "", url: release.html_url || RELEASE_PAGE };
    return { status: "current", current, latest: latest || current };
  } catch (error) {
    return { status: "error", current, reason: humanize(error) };
  }
}

/** 下载、验签、安装，然后重启。只应在 status==='available' 时调用。 */
export async function installUpdate(update, { onProgress } = {}) {
  if (!update) throw new Error("没有可安装的更新");
  await update.downloadAndInstall(event => {
    if (!onProgress) return;
    if (event.event === "Started") onProgress({ phase: "started", total: event.data?.contentLength || 0 });
    else if (event.event === "Progress") onProgress({ phase: "progress", chunk: event.data?.chunkLength || 0 });
    else if (event.event === "Finished") onProgress({ phase: "installing" });
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export function openReleasePage(url = RELEASE_PAGE, tauri = globalThis.__TAURI__) {
  return tauri.core.invoke("open_external_url", { url });
}

function humanize(error) {
  const text = String(error?.message || error || "");
  if (/timed? ?out|TimeoutError/i.test(text)) return "检查超时，请稍后重试";
  if (/network|fetch|Failed to fetch/i.test(text)) return "网络不可用，请检查连接";
  return text.slice(0, 200) || "检查失败";
}
