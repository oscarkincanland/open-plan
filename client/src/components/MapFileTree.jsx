import React, { useEffect, useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import 文件类型图标 from "./FileTypeIcon.jsx";
import { mapProjectTree, listFiles, searchFiles } from "../api.js";

/**
 * 地图文件树浮层（地图面板入口）
 *
 * 项目文件：maps/{project}/ 下 layers、agent（报告/导出/清单）等文件；
 *           按文件夹分组，搜索走服务端 q（对目录+文件名匹配）。
 * 工作区：复用 /api/files 与 /api/files/search；支持目录导航与按路径搜索。
 * 每行提供 @ 按钮：把地图项目内相对工作区路径插入对话输入框。
 */
const SIZE_UNITS = ["B", "KB", "MB", "GB"];

function formatSize(value) {
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) { size /= 1024; unit += 1; }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

function fileExtOf(name = "") {
  const match = String(name).match(/\.[^.]+$/);
  return match ? match[0].slice(1).toLowerCase() : "";
}

function FileRow({ path, name, ext, size, isDir = false, onOpen, onAt, hint = "" }) {
  const file = { name, ext, size, isDir };
  return (
    <div className="mp-filetree-row">
      <button
        type="button"
        className="mp-filetree-open"
        onClick={() => onOpen?.(path)}
        title={isDir ? `进入 ${name}` : `打开 ${path}`}
        aria-label={isDir ? `进入文件夹 ${name}` : `打开文件 ${path}`}
      >
        <文件类型图标 file={file} size={14} />
        <span className="mp-filetree-name">{name}</span>
        {hint && <span className="mp-filetree-hint">{hint}</span>}
        {!isDir && <small className="mp-filetree-size">{formatSize(size)}</small>}
      </button>
      {!isDir && onAt && (
        <button
          type="button"
          className="mp-filetree-at"
          onClick={() => onAt(path)}
          title={`把 @${path} 插入对话输入框`}
          aria-label={`提及文件 ${name}`}
        >
          <Icon name="at" size={12} />
        </button>
      )}
    </div>
  );
}

export default function 地图文件树({ project, workspace = "", insertChatText, onOpenFile, onClose }) {
  const [tab, setTab] = useState("project");
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [wsDir, setWsDir] = useState("");
  const [wsFiles, setWsFiles] = useState([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState("");

  // 项目文件：项目名或搜索词变化时拉取（搜索走服务端，按文件夹匹配）。
  useEffect(() => {
    if (tab !== "project" || !project) return undefined;
    let cancelled = false;
    setTreeLoading(true);
    setTreeError("");
    const timer = setTimeout(async () => {
      try {
        const result = await mapProjectTree(project, query.trim());
        if (!cancelled) setTree(result);
      } catch (error) {
        if (!cancelled) setTreeError(error?.message || "项目文件读取失败");
      } finally {
        if (!cancelled) setTreeLoading(false);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [tab, project, query]);

  // 工作区：搜索词优先走递归搜索，否则列当前目录。
  useEffect(() => {
    if (tab !== "workspace") return undefined;
    let cancelled = false;
    setWsLoading(true);
    setWsError("");
    const timer = setTimeout(async () => {
      try {
        if (query.trim()) {
          const result = await searchFiles(query.trim(), 200, workspace);
          if (!cancelled) setWsFiles(result.files || []);
        } else {
          const result = await listFiles(wsDir, workspace);
          if (!cancelled) setWsFiles(result.files || []);
        }
      } catch (error) {
        if (!cancelled) setWsError(error?.message || "工作区文件读取失败");
      } finally {
        if (!cancelled) setWsLoading(false);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [tab, query, wsDir, workspace]);

  const treeGroups = useMemo(() => {
    const groups = new Map();
    for (const file of tree?.files || []) {
      const key = file.dir || "根目录";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }
    return [...groups.entries()];
  }, [tree]);

  const atProjectFile = (rel) => {
    // 项目文件以工作区相对路径提及，Agent 可直接读取 maps/{project}/ 下的数据。
    insertChatText?.(`@maps/${project}/${rel}`);
  };
  const atWorkspaceFile = (rel) => {
    insertChatText?.(`@${rel}`);
  };

  return (
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div
        className="mp-iso-panel mp-filetree-panel"
        role="dialog"
        aria-modal="true"
        aria-label="地图文件树"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mp-iso-head">
          <span><Icon name="folder" size={14} /> 文件树「{project}」</span>
          <button className="mp-op" type="button" aria-label="关闭文件树" title="关闭文件树" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="mp-iso-body">
          <div className="mp-filetree-tabs" role="tablist" aria-label="文件树范围">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "project"}
              className={tab === "project" ? "active" : ""}
              onClick={() => setTab("project")}
            >
              <Icon name="layers" size={12} /> 项目文件
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "workspace"}
              className={tab === "workspace" ? "active" : ""}
              onClick={() => setTab("workspace")}
            >
              <Icon name="folder" size={12} /> 工作区文件
            </button>
          </div>

          <div className="mp-filetree-search">
            <Icon name="search" size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === "project" ? "按文件夹或文件名搜索（如 layers、agent、报告）" : "按路径搜索工作区文件"}
              aria-label="搜索文件或文件夹"
            />
            {query && (
              <button type="button" className="mp-filetree-clear" onClick={() => setQuery("")} aria-label="清除搜索" title="清除搜索">
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          {tab === "project" ? (
            <div className="mp-filetree-list" aria-live="polite">
              {treeLoading ? (
                <div className="mp-filetree-empty" role="status">正在读取项目文件…</div>
              ) : treeError ? (
                <div className="mp-filetree-empty">{treeError}</div>
              ) : treeGroups.length === 0 ? (
                <div className="mp-filetree-empty">
                  {query ? `没有匹配「${query}」的文件` : "项目内暂无文件；导入图层或让 Agent 生成后会出现在这里"}
                </div>
              ) : (
                treeGroups.map(([dir, files]) => (
                  <div className="mp-filetree-group" key={dir}>
                    <div className="mp-filetree-group-head"><Icon name="folder" size={12} /> {dir}</div>
                    {files.map((file) => (
                      <FileRow
                        key={file.rel}
                        path={file.rel}
                        name={file.name}
                        ext={file.ext}
                        size={file.size}
                        onOpen={(rel) => onOpenFile?.(`maps/${project}/${rel}`)}
                        onAt={atProjectFile}
                        hint={file.dir === "agent" || file.dir?.startsWith("agent/") ? "agent 生成" : ""}
                      />
                    ))}
                  </div>
                ))
              )}
              {tree?.truncated && <div className="mp-filetree-note">文件较多，仅显示前 500 条；可用搜索缩小范围。</div>}
            </div>
          ) : (
            <div className="mp-filetree-list" aria-live="polite">
              {wsLoading ? (
                <div className="mp-filetree-empty" role="status">正在读取工作区文件…</div>
              ) : wsError ? (
                <div className="mp-filetree-empty">{wsError}</div>
              ) : wsFiles.length === 0 ? (
                <div className="mp-filetree-empty">{query ? `没有匹配「${query}」的工作区文件` : "当前目录暂无文件"}</div>
              ) : (
                <>
                  {!query && wsDir && (
                    <FileRow
                      path=".."
                      name="上一级"
                      ext="folder"
                      isDir
                      onOpen={() => setWsDir(wsDir.split("/").slice(0, -1).join("/"))}
                    />
                  )}
                  {wsFiles.map((file) => {
                    const rel = query ? (file.relPath || file.name) : (wsDir ? `${wsDir}/${file.name}` : file.name);
                    return (
                      <FileRow
                        key={rel}
                        path={rel}
                        name={file.name}
                        ext={file.ext || fileExtOf(file.name)}
                        size={file.size}
                        isDir={Boolean(file.isDir)}
                        onOpen={(value) => {
                          if (file.isDir) { setWsDir(value); setQuery(""); return; }
                          onOpenFile?.(value);
                        }}
                        onAt={atWorkspaceFile}
                      />
                    );
                  })}
                </>
              )}
              {!query && <div className="mp-filetree-note">当前目录：{wsDir || "工作区根目录"}</div>}
            </div>
          )}

          <div className="mp-filetree-foot">
            点击 <Icon name="at" size={12} /> 把路径插入对话输入框，Agent 可直接读取；图层文件可在地图中打开。
          </div>
        </div>
      </div>
    </div>
  );
}
