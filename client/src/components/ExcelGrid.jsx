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

export default function ExcelGrid({ name, sheets, grids, truncated, maxRows, officeHtmlUrl = "" }) {
  const hostRef = useRef(null);
  const [spread, setSpread] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  // 网格只承载“单元格值”；公式/样式/合并单元格由 OfficeCLI HTML 只读预览补足。
  const [officeMode, setOfficeMode] = useState(false);
  const sheetNames = Array.isArray(sheets) ? sheets : [];
  const hasSheets = sheetNames.length > 0;
  // 保存时记录每个 sheet 的初始数据
  const initialRef = useRef({});

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

  // 一次加载所有 sheets（带 name），x-spreadsheet 底部标签栏可切换；
  // merges/cols 透传给渲染器（合并单元格 + 原生列宽，此前全部丢失）。
  useEffect(() => {
    if (!spread || !hasSheets) return;
    const allSheets = sheetNames.map((s) => gridToSheetData(s, grids?.[s]));
    initialRef.current = {};
    for (const s of sheetNames) {
      initialRef.current[s] = sheetToGridKey(gridToSheetData(s, grids?.[s]));
    }
    spread.loadData(allSheets);
    if (typeof spread.change === "function") spread.change(() => {});
  }, [spread, hasSheets, sheetNames, grids]);

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

  const truncatedList = Array.isArray(truncated) ? truncated : [];
  const truncatedNames = new Set(truncatedList.map((t) => t?.name));

  const handleSave = async () => {
    if (!spread) return;
    // getData 返回所有 sheet 的数据数组
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
        <span className="excel-sheet-hint">底部标签栏可切换工作表</span>
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
      <div ref={hostRef} className="excel-host" style={officeMode ? { display: "none" } : undefined} />
      {officeMode && officeHtmlUrl && (
        <div className="excel-office">
          <iframe title={`${name} 高保真预览`} src={officeHtmlUrl} className="excel-office-frame" />
          <div className="excel-office-hint">OfficeCLI 高保真只读渲染；如显示异常可切回表格编辑。</div>
        </div>
      )}
    </div>
  );
}
