import React, { useEffect, useRef, useState } from "react";
import Spreadsheet from "x-data-spreadsheet";
import "x-data-spreadsheet/dist/xspreadsheet.css";
import { saveCells } from "../api.js";
import Icon from "./Icon.jsx";

function indexToCol(i) { let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - r) / 26); } return s; }

// 行列键统一为 0-based（与 x-spreadsheet 坐标系一致；此前服务端给 1-based 键，
// 渲染整体偏移一格、首行首列恒为空）。保存引用 A1 = 列号+1 的字母 + 行号+1。
function gridToSheetData(name, grid) {
  const source = grid?.rows || grid || {};
  const rows = {};
  for (const key of Object.keys(source)) {
    const ri = Number(key);
    if (!Number.isFinite(ri)) continue;
    const cells = {};
    for (const ck of Object.keys(source[key]?.cells || {})) {
      const ci = Number(ck);
      if (!Number.isFinite(ci)) continue;
      cells[ci] = { text: String(source[key].cells[ck]?.text ?? "") };
    }
    rows[ri] = { cells };
  }
  const data = { name, rows };
  if (Array.isArray(grid?.merges) && grid.merges.length) data.merges = grid.merges;
  if (grid?.cols && Object.keys(grid.cols).length) {
    const cols = {};
    for (const ck of Object.keys(grid.cols)) {
      const width = Number(grid.cols[ck]?.width);
      if (Number.isFinite(width)) cols[Number(ck)] = { width };
    }
    data.cols = cols;
  }
  return data;
}

function sheetToGridKey(sheetData) {
  const rows = {};
  for (const key of Object.keys(sheetData?.rows || {})) {
    const cells = {};
    for (const ck of Object.keys(sheetData.rows[key]?.cells || {})) {
      cells[ck] = { text: String(sheetData.rows[key].cells[ck]?.text ?? "") };
    }
    rows[key] = { cells };
  }
  return rows;
}

export default function ExcelGrid({ name, sheets, grids, truncated, maxRows, officeHtmlUrl = "", lazySheets = false, sheetBase = "" }) {
  const hostRef = useRef(null);
  const [spread, setSpread] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  // 网格只承载“单元格值”；公式/样式/合并单元格由 OfficeCLI HTML 只读预览补足。
  const [officeMode, setOfficeMode] = useState(false);
  const sheetNames = Array.isArray(sheets) ? sheets : [];
  const hasSheets = sheetNames.length > 0;
  const isLazy = Boolean(lazySheets && sheetBase && hasSheets);
  // P3-c 懒加载态：当前展示的表与已取回的网格缓存（name → grid）
  const [activeSheet, setActiveSheet] = useState(() => sheetNames[0] || "");
  const sheetCacheRef = useRef(new Map());
  const [loadingSheet, setLoadingSheet] = useState("");
  const [sheetTruncated, setSheetTruncated] = useState(Array.isArray(truncated) ? truncated : []);
  const activeSheetRef = useRef(activeSheet);
  activeSheetRef.current = activeSheet;
  // 保存时记录每个 sheet 的初始数据
  const initialRef = useRef({});

  // 换文件即弃缓存：网格缓存/活动表/截断提示都跟当前文件走（声明在种缓存 effect 之前，先执行）
  useEffect(() => {
    sheetCacheRef.current = new Map();
    setActiveSheet(Array.isArray(sheets) ? sheets[0] || "" : "");
    setSheetTruncated(Array.isArray(truncated) ? truncated : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!hostRef.current || !hasSheets) return undefined;
    const s = new Spreadsheet(hostRef.current, {
      showToolbar: true,
      showGrid: true,
      view: { height: () => Math.max(200, hostRef.current?.clientHeight - 40) },
    });
    setSpread(s);
    return () => { if (typeof s.destroy === "function") try { s.destroy(); } catch {} };
  }, [hasSheets]);

  // 整簿模式（基线）：一次加载所有 sheets（带 name），x-spreadsheet 底部标签栏可切换；
  // merges/cols 透传给渲染器（合并单元格 + 原生列宽，此前全部丢失）。
  // 懒加载模式：只把「已取回网格」的表灌入（懒加载下初始只有第一个表），
  // 切页签由自建页签条接管（见下方 switchSheet）。
  useEffect(() => {
    if (!spread || !hasSheets) return;
    // P3-c：把服务端已返回的网格种入缓存（懒加载首屏只有第一个表；整簿模式全量种入）
    for (const s of sheetNames) {
      if (grids?.[s] && !sheetCacheRef.current.has(s)) sheetCacheRef.current.set(s, grids[s]);
    }
    const loaded = isLazy ? sheetNames.filter((s) => sheetCacheRef.current.has(s)) : sheetNames;
    const allSheets = loaded.map((s) => gridToSheetData(s, sheetCacheRef.current.get(s) || grids?.[s]));
    initialRef.current = {};
    for (const s of loaded) {
      initialRef.current[s] = sheetToGridKey(gridToSheetData(s, sheetCacheRef.current.get(s) || grids?.[s]));
    }
    spread.loadData(allSheets);
    if (typeof spread.change === "function") spread.change(() => {});
  }, [spread, hasSheets, sheetNames, grids, isLazy]);

  // 懒加载：按需取回单表网格（缓存命中不重复请求；快照开关未开启时本组件不会收到 lazySheets）
  const fetchSheet = async (sheetName) => {
    if (!sheetBase || !sheetName) return null;
    try {
      const sep = sheetBase.includes("?") ? "&" : "?";
      const r = await fetch(`${sheetBase}${sep}sheet=${encodeURIComponent(sheetName)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`请求失败（${r.status}）`);
      const data = await r.json();
      if (data?.grid) sheetCacheRef.current.set(data.name || sheetName, data.grid);
      setSheetTruncated(Array.isArray(data?.truncated) ? data.truncated : []);
      return data?.grid || null;
    } catch (e) {
      setMsg(`加载工作表失败：${e.message || "网络错误"}`);
      setTimeout(() => setMsg(""), 3000);
      return null;
    }
  };

  // 懒加载切页签：有未保存修改先确认（当前 Widget 只装一张表，切换即离开该表数据）；
  // 成功后把新表灌入 Widget。
  const switchSheet = async (sheetName) => {
    if (!spread || !isLazy || sheetName === activeSheetRef.current || loadingSheet) return;
    const sd = spread.getData?.()?.[0];
    if (sd) {
      const current = sheetToGridKey(sd);
      const initial = initialRef.current[activeSheetRef.current] || {};
      const keys = new Set([...Object.keys(current), ...Object.keys(initial)]);
      const dirty = [...keys].some((ri) => {
        const cells = new Set([...Object.keys(current[ri]?.cells || {}), ...Object.keys(initial[ri]?.cells || {})]);
        return [...cells].some((ci) => (current[ri]?.cells?.[ci]?.text ?? "") !== (initial[ri]?.cells?.[ci]?.text ?? ""));
      });
      if (dirty && !window.confirm("当前工作表有未保存的修改，切换后将丢失。确定切换？")) return;
    }
    setLoadingSheet(sheetName);
    let grid = sheetCacheRef.current.get(sheetName);
    if (!grid) grid = await fetchSheet(sheetName);
    setLoadingSheet("");
    if (!grid) return;
    setActiveSheet(sheetName);
    const sheetData = gridToSheetData(sheetName, grid);
    initialRef.current[sheetName] = sheetToGridKey(sheetData);
    spread.loadData([sheetData]);
    if (typeof spread.change === "function") spread.change(() => {});
  };

  // sheets 为空（文件读取失败）时显示错误。放在 hooks 之后，避免文件从加载中
  // 变为可读时触发 React 的 hooks 顺序错误。
  if (!hasSheets) {
    return (
      <div className="excel-wrap">
        <div className="excel-toolbar">
          <span className="badge">可编辑</span>
        </div>
        <div className="excel-empty">
          <div><Icon name="warning" size={14} /> 无法读取工作表</div>
          <div className="hint">文件可能已损坏、被占用（Excel 打开中），或格式不受支持</div>
        </div>
      </div>
    );
  }

  const truncatedList = isLazy ? sheetTruncated : (Array.isArray(truncated) ? truncated : []);
  const truncatedNames = new Set(truncatedList.map((t) => t?.name));

  const handleSave = async () => {
    if (!spread) return;
    // getData 返回所有 sheet 的数据数组（懒加载模式只有当前表一张）
    const allData = spread.getData(); // [{ name, rows }]
    const changedBySheet = {};
    for (const sd of allData) {
      const sname = sd.name;
      const current = sd.rows || {};
      const initial = initialRef.current[sname] || {};
      const cells = [];
      const allKeys = new Set([...Object.keys(current), ...Object.keys(initial)]);
      for (const ri of allKeys) {
        const cur = current[ri]?.cells || {};
        const ini = initial[ri]?.cells || {};
        for (const ci of new Set([...Object.keys(cur), ...Object.keys(ini)])) {
          const cv = cur[ci]?.text ?? "";
          const iv = ini[ci]?.text ?? "";
          if (cv !== iv) {
            // 0-based 行列键 → A1 引用（Excel 单元格从 A1 开始，1-based）
            cells.push({ ref: indexToCol(Number(ci) + 1) + (Number(ri) + 1), value: cv });
          }
        }
      }
      if (cells.length) changedBySheet[sname] = cells;
    }
    const total = Object.values(changedBySheet).reduce((a, b) => a + b.length, 0);
    if (!total) { setMsg("没有需要保存的改动"); setTimeout(() => setMsg(""), 2000); return; }
    setSaving(true);
    try {
      for (const [sname, cells] of Object.entries(changedBySheet)) {
        await saveCells(name, sname, cells);
      }
      setMsg(`已保存 ${total} 个单元格`);
      // 更新初始数据
      for (const sd of allData) {
        initialRef.current[sd.name] = sheetToGridKey(sd);
      }
    } catch (e) { setMsg("保存失败：" + e.message); }
    setSaving(false);
    setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="excel-wrap">
      <div className="excel-toolbar">
        <span className="badge">工作簿 · {sheets.length} 个工作表</span>
        {!isLazy && <span className="excel-sheet-hint">底部标签栏可切换工作表</span>}
        <span className="badge">仅显示单元格值</span>
        <span className="excel-sheet-hint">公式、样式、合并单元格不在网格预览中；底部标签栏可切换工作表</span>
        {truncatedList.length > 0 && (
          <span
            className="excel-truncated"
            title={truncatedList.map((t) => `${t.name}：共 ${t.totalRows} 行，仅显示前 ${maxRows} 行`).join("\n")}
          >
            ⚠ 大表已截断显示（每表前 {maxRows} 行），编辑保存仅覆盖可见区域
          </span>
        )}
        {officeHtmlUrl && (
          <button className="btn-sm" onClick={() => setOfficeMode((value) => !value)} title={officeMode ? "切回可编辑的值网格" : "OfficeCLI 高保真只读预览（查看公式/样式/合并单元格）"}>
            {officeMode ? "表格编辑" : "高保真预览"}
          </button>
        )}
        {!officeMode && (
          <button className="btn primary" onClick={handleSave} disabled={saving} title="只保存修改过的单元格值；编辑公式单元格会把公式替换为文本">
            {saving ? "保存中…" : "保存修改"}
          </button>
        )}
        {msg && <span className="save-msg">{msg}</span>}
      </div>
      {officeMode && officeHtmlUrl && (
        <div className="excel-office">
          <iframe title={`${name} 高保真预览`} src={officeHtmlUrl} className="excel-office-frame" />
          <div className="excel-office-hint">OfficeCLI 高保真只读渲染；如显示异常可切回表格编辑。</div>
        </div>
      )}
      {isLazy && (
        <div className="excel-lazy-tabs" role="tablist" aria-label="工作表切换">
          {sheetNames.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === activeSheet}
              className={`excel-lazy-tab${s === activeSheet ? " is-active" : ""}${truncatedNames.has(s) ? " has-truncated" : ""}`}
              title={truncatedNames.has(s) ? `该表共 ${truncatedList.find((t) => t?.name === s)?.totalRows ?? "?"} 行，已截断显示` : s}
              onClick={() => switchSheet(s)}
            >
              {s}
            </button>
          ))}
          {loadingSheet && <span className="excel-lazy-loading">加载 {loadingSheet} …</span>}
        </div>
      )}
      <div ref={hostRef} className="excel-host" style={officeMode ? { display: "none" } : undefined} />
    </div>
  );
}
