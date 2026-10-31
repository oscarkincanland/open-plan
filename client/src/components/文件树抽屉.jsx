import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import 文件类型图标 from "./文件类型图标.jsx";

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|kt|css|scss|less|json|yml|yaml|toml|sh|bat|ps1|sql|r|sas)$/i;
const WEB_EXT = /\.(html?|htm|svg)$/i;

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function breadcrumb(dir = "") {
  const parts = String(dir || "").split("/").filter(Boolean);
  const trail = [{ label: "工作区", dir: "" }];
  parts.forEach((part, index) => trail.push({ label: part, dir: parts.slice(0, index + 1).join("/") }));
  return trail;
}

/**
 * 工作区画布右侧文件树抽屉。
 * 自己维护当前目录，直接走 /api/files?dir=，不改变左侧文件页的当前目录。
 */
export default function 文件树抽屉({
  workspace = "",
  currentName = "",
  onOpenFile,
  onClose,
  refreshToken = 0,
}) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const seqRef = useRef(0);

  const load = useCallback(async (targetDir = dir) => {
    if (!workspace) {
      setEntries([]);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ workspace, dir: targetDir || "" });
      const response = await fetch(`/api/files?${params.toString()}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (!response.ok) throw new Error(data?.error || `读取文件失败（HTTP ${response.status}）`);
      setEntries(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setEntries([]);
      setError(String(err?.message || "读取文件失败"));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [dir, workspace]);

  useEffect(() => { void load(dir); }, [dir, workspace, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const dirs = entries.filter((entry) => entry?.isDir);
    const files = entries.filter((entry) => entry && !entry.isDir && entry.name);
    const filtered = files.filter((file) => {
      if (filter === "code") return CODE_EXT.test(file.name);
      if (filter === "web") return WEB_EXT.test(file.name);
      return true;
    });
    return [...dirs, ...filtered];
  }, [entries, filter]);

  const trail = breadcrumb(dir);
  const empty = !loading && !error && list.length === 0;

  return (
    <div className="canvas-filetree" aria-label="工作区文件树">
      <div className="canvas-filetree-head">
        <div className="canvas-filetree-crumbs" aria-label="当前目录">
          {trail.map((item, index) => (
            <span key={`${item.dir}-${item.label}`} className="canvas-filetree-crumb">
              {index > 0 && <Icon name="chevronRight" size={10} />}
              <button type="button" onClick={() => setDir(item.dir)} title={item.dir || "工作区根目录"}>
                {item.label}
              </button>
            </span>
          ))}
        </div>
        <div className="canvas-filetree-tools">
          {dir && <button type="button" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))} title="返回上一级" aria-label="返回上一级"><Icon name="chevronLeft" size={12} /></button>}
          <button type="button" onClick={() => void load(dir)} title="刷新文件" aria-label="刷新文件"><Icon name="refresh" size={12} /></button>
          {onClose && <button type="button" onClick={onClose} title="关闭文件树" aria-label="关闭文件树"><Icon name="close" size={12} /></button>}
        </div>
      </div>
      <div className="canvas-filetree-toolbar" role="tablist" aria-label="文件过滤">
        {[["all", "全部"], ["code", "代码"], ["web", "网页"]].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
            title={`按${label}过滤文件`}
          >{label}</button>
        ))}
      </div>
      {loading ? (
        <div className="canvas-filetree-empty" role="status">正在读取目录…</div>
      ) : error ? (
        <div className="canvas-filetree-empty" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-xs" onClick={() => void load(dir)}>重试</button>
        </div>
      ) : empty ? (
        <div className="canvas-filetree-empty">
          {entries.length === 0 ? "当前目录为空" : `没有${filter === "code" ? "代码" : filter === "web" ? "网页" : ""}文件`}
        </div>
      ) : (
        <ul className="canvas-filetree-list" aria-label="工作区文件与目录">
          {list.map((entry) => {
            const relPath = joinPath(dir, entry.name);
            const active = !entry.isDir && entry.name === currentName;
            return (
              <li key={`${entry.isDir ? "dir" : "file"}:${relPath}`}>
                <button
                  type="button"
                  className={`canvas-filetree-item${active ? " active" : ""}${entry.isDir ? " is-dir" : ""}`}
                  onClick={() => {
                    if (entry.isDir) setDir(relPath);
                    else onOpenFile?.(relPath);
                  }}
                  title={relPath}
                >
                  {entry.isDir ? <Icon name="folder" size={15} /> : <文件类型图标 file={entry} size={15} />}
                  <span className="canvas-filetree-name">{entry.name}</span>
                  {entry.isDir
                    ? <Icon name="chevronRight" size={11} className="canvas-filetree-chevron" />
                    : <span className="canvas-filetree-size">{entry.size >= 1024 ? `${Math.round(entry.size / 1024)}k` : `${entry.size || 0}b`}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
