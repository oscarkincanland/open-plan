import { useState } from "react";
import Icon from "./Icon.jsx";

// v0.13.9 画布「文件树」页签：工作区文件的快速导航视图。
// 三段过滤（全部 / 代码 / 网页）覆盖 AVA 的代码、网页页签语义——
// 点击文件在预览（工作产物）页签打开，不替代左侧文件页。
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|kt|css|scss|less|json|yml|yaml|toml|sh|bat|ps1|sql|r|sas)$/i;
const WEB_EXT = /\.(html?|htm|svg)$/i;

export default function 文件树页签({ files = [], loading = false, currentName = "", onOpenFile, onRefresh }) {
  const [filter, setFilter] = useState("all");
  const list = (Array.isArray(files) ? files : []).filter((file) => file?.name && !file.isDir);
  const filtered = list.filter((file) => {
    if (filter === "code") return CODE_EXT.test(file.name);
    if (filter === "web") return WEB_EXT.test(file.name);
    return true;
  });
  return (
    <div className="canvas-filetree">
      <div className="canvas-filetree-toolbar" role="tablist" aria-label="文件过滤">
        {[["all", "全部"], ["code", "代码"], ["web", "网页"]].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
            title={`按${label}过滤工作区文件`}
          >{label}</button>
        ))}
        <button type="button" className="canvas-filetree-refresh" onClick={onRefresh} aria-label="刷新文件列表" title="刷新文件列表">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {loading ? (
        <div className="canvas-filetree-empty" role="status">正在加载文件…</div>
      ) : filtered.length === 0 ? (
        <div className="canvas-filetree-empty">
          {list.length === 0 ? "工作区暂无文件：把文件放进工作区后点击刷新" : `没有${filter === "code" ? "代码" : filter === "web" ? "网页" : ""}文件`}
        </div>
      ) : (
        <ul className="canvas-filetree-list" aria-label="工作区文件">
          {filtered.map((file) => (
            <li key={file.name}>
              <button
                type="button"
                className={`canvas-filetree-item${file.name === currentName ? " active" : ""}`}
                onClick={() => onOpenFile?.(file.name)}
                title={file.name}
              >
                <Icon name={CODE_EXT.test(file.name) ? "code" : WEB_EXT.test(file.name) ? "globe" : "file"} size={13} />
                <span className="canvas-filetree-name">{file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
