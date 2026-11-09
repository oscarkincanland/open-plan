import React, { useEffect, useRef, useState } from "react";
import { getCanvas, getCanvasBoard } from "../api.js";
import { normalizeBoard, normalizeCanvas, 板条目, 素材地址, 清洗SVG } from "../画布/画布模型.js";

/**
 * 创作画布导出视图（`?export=canvas&slug=&board=&boards=&format=&workspace=&scale=`）。
 *
 * 单一职责：
 *   1. 按查询参数渲染：`board=` 单板（PNG 截图）；`boards=A,B` 多板（PDF 多页）；
 *   2. 渲染稳定后置 `window.__OAW_EXPORT_READY = true`，供服务端内置浏览器轮询后截图/打印；
 *   3. 失败置 `window.__OAW_EXPORT_ERROR`，服务端据此让导出任务失败并给出原因。
 *
 * 与地图导出视图（地图导出视图.jsx）同口径：服务端负责视口尺寸（Emulation.setDeviceMetricsOverride）、
 * 截图（PNG）与 printToPDF；本页不做任何交互控件，也不执行兼容板内的脚本（iframe 只开 allow-same-origin）。
 *
 * 取数只用 api.js 的 getCanvas / getCanvasBoard；元素渲染与编辑器（创作画布.jsx）保持同一套归一化规则
 * （都来自 画布/画布模型.js），此处只做导出所需的静态渲染，不复用编辑器交互组件。
 */

const 参数 = new URLSearchParams(window.location.search);
/** 视图开关：main.jsx 按 export=canvas 懒加载本组件，这里再自校验一次，防止被误开。 */
const 视图参数 = String(参数.get("export") || "").trim();
const 画布标识 = String(参数.get("slug") || "").trim();
const 工作区 = String(参数.get("workspace") || "").trim();
const 板参数 = String(参数.get("board") || "").trim();
/** 多板导出（PDF 分页）：`boards=A,B`；单板 PNG 仍用 board=。 */
const 多板参数 = String(参数.get("boards") || "")
  .split(/[,，;；\s]+/)
  .map((项) => 项.trim())
  .filter(Boolean);
const 导出格式 = String(参数.get("format") || "").trim().toLowerCase();
const 缩放参数 = Number(参数.get("scale"));
/** 导出缩放：默认 1（1 CSS px = 1 px），服务端负责最终像素尺寸与上限。 */
const 导出缩放 = Number.isFinite(缩放参数) && 缩放参数 > 0 ? Math.min(4, Math.max(0.1, 缩放参数)) : 1;

function 标错(消息) {
  window.__OAW_EXPORT_ERROR = String(消息 || "导出视图失败");
}

function 取字段(应答, 键) {
  if (应答 && typeof 应答 === "object" && 应答[键] !== undefined && 应答[键] !== null) return 应答[键];
  return 应答;
}

/** 视口稳定：服务端先 open 再 resize 视口，等 innerWidth/Height 连续两次一致再定尺寸。 */
async function 等待视口稳定() {
  let 上次 = { w: window.innerWidth, h: window.innerHeight };
  for (let i = 0; i < 20; i += 1) {
    await new Promise((完成) => setTimeout(完成, 250));
    const 当前 = { w: window.innerWidth, h: window.innerHeight };
    if (当前.w === 上次.w && 当前.h === 上次.h) return 当前;
    上次 = 当前;
  }
  return 上次;
}

/** 等容器内图片解码完成（图片未就绪就截图会得到空块）。 */
async function 等待图片(容器) {
  if (!容器) return;
  const 图片 = [...容器.querySelectorAll("img")];
  await Promise.all(
    图片.map(
      (图) =>
        new Promise((完成) => {
          if (图.complete) {
            完成();
            return;
          }
          图.addEventListener("load", () => 完成(), { once: true });
          图.addEventListener("error", () => 完成(), { once: true });
          // 兜底：单张图最多等 5s，不让导出无限挂起
          setTimeout(完成, 5000);
        }),
    ),
  );
}

/** 等兼容板 iframe 完成加载（sandbox 里不开脚本，只需 DOM 就绪）；多板时逐个等。 */
async function 等待框架(容器) {
  if (!容器) return;
  const 框架们 = [...容器.querySelectorAll("iframe")];
  for (const 框架 of 框架们) {
    for (let i = 0; i < 40; i += 1) {
      try {
        if (框架.contentDocument?.readyState === "complete") break;
      } catch {
        // 跨源/未就绪时继续等，超时后照常截图
      }
      await new Promise((完成) => setTimeout(完成, 100));
    }
  }
}

/** 导出页元素样式（与创作画布.jsx 的 元素样式表 同规则；导出页不需要 hover/选中态）。 */
function 元素样式(元素) {
  const 样式 = 元素.style || {};
  const 基 = { position: "absolute", left: 元素.x, top: 元素.y, width: Math.max(元素.w, 1), height: Math.max(元素.h, 0) };
  if (元素.type === "text") {
    return {
      ...基,
      fontFamily: 样式.fontFamily || "inherit",
      fontSize: 样式.fontSize || 16,
      fontWeight: 样式.fontWeight || 400,
      lineHeight: 样式.lineHeight || 1.3,
      color: 样式.color || "inherit",
      textAlign: 样式.textAlign || "left",
      opacity: 样式.opacity ?? 1,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
    };
  }
  if (元素.type === "rect") {
    return {
      ...基,
      background: 样式.fill || "transparent",
      border: 样式.stroke ? `${样式.strokeWidth || 1}px solid ${样式.stroke}` : "none",
      borderRadius: 样式.radius || 0,
      opacity: 样式.opacity ?? 1,
    };
  }
  return { ...基, opacity: 样式.opacity ?? 1 };
}

function 导出元素({ 元素, 素材前缀 }) {
  const 样式 = 元素样式(元素);
  if (元素.type === "text") {
    return <div style={样式}>{元素.text || ""}</div>;
  }
  if (元素.type === "rect") {
    return <div style={样式} />;
  }
  if (元素.type === "line") {
    const x1 = 元素.x1 ?? 元素.x;
    const y1 = 元素.y1 ?? 元素.y;
    const x2 = 元素.x2 ?? 元素.x + 元素.w;
    const y2 = 元素.y2 ?? 元素.y + 元素.h;
    const 左 = Math.min(x1, x2);
    const 上 = Math.min(y1, y2);
    const 宽 = Math.max(Math.abs(x2 - x1), 1);
    const 高 = Math.max(Math.abs(y2 - y1), 1);
    return (
      <svg style={{ ...样式, left: 左, top: 上, width: 宽, height: 高 }} viewBox={`${左} ${上} ${宽} ${高}`} preserveAspectRatio="none">
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={元素.style?.stroke || "currentColor"} strokeWidth={元素.style?.strokeWidth || 1} />
      </svg>
    );
  }
  const 图源 = 元素.markup
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(清洗SVG(元素.markup))}`
    : 元素.src
      ? `${素材前缀}${encodeURIComponent(元素.src)}`
      : "";
  if (!图源) return null;
  return (
    <img
      src={图源}
      alt=""
      draggable={false}
      style={{ ...样式, objectFit: 元素.type === "svg" ? "contain" : 元素.fit === "contain" || 元素.fit === "fill" ? 元素.fit : "cover" }}
    />
  );
}

export default function 创作画布导出视图() {
  const [状态, set状态] = useState("加载中"); // 加载中 | 就绪 | 失败
  const [错误, set错误] = useState("");
  const [数据, set数据] = useState(null); // { 画布, 项们: [{条目, 板}], 多板 }
  const 容器引用 = useRef(null);

  useEffect(() => {
    window.__OAW_EXPORT_READY = false;
    window.__OAW_EXPORT_ERROR = "";
  }, []);

  // 取数：坐标/尺寸以 canvas.json 的 boards 条目为准，内容以板接口为准
  useEffect(() => {
    let 取消 = false;
    (async () => {
      if (视图参数 && 视图参数 !== "canvas") {
        标错(`未知导出视图：${视图参数}`);
        set错误(`未知导出视图：${视图参数}`);
        set状态("失败");
        return;
      }
      if (!画布标识) {
        标错("缺少 slug 参数");
        set错误("缺少 slug 参数");
        set状态("失败");
        return;
      }
      try {
        const 画布 = normalizeCanvas(取字段(await getCanvas(工作区, 画布标识), "canvas"));
        const 全部条目 = 板条目(画布);
        let 目标条目 = [];
        if (多板参数.length) {
          目标条目 = 多板参数
            .map((路径) => 全部条目.find((项) => 项.path === 路径))
            .filter(Boolean);
          if (目标条目.length !== 多板参数.length) {
            const 缺失 = 多板参数.filter((路径) => !全部条目.some((项) => 项.path === 路径));
            throw new Error(`画布缺少要导出的画板：${缺失.join("、")}`);
          }
        } else if (板参数) {
          const 单条 = 全部条目.find((项) => 项.path === 板参数);
          if (!单条) throw new Error(`画布缺少要导出的画板：${板参数}`);
          目标条目 = [单条];
        } else {
          目标条目 = 全部条目.slice(0, 1);
        }
        if (!目标条目.length) throw new Error("画布没有可导出的板");
        const 项们 = [];
        for (const 条目 of 目标条目) {
          // 串行取数：多板 PDF 时顺序稳定，失败也能指出具体板
          const 应答 = await getCanvasBoard(工作区, 画布标识, 条目.path);
          if (取消) return;
          const 内容 = 取字段(应答, "board");
          const 板 = 条目.type === "object"
            ? normalizeBoard(内容, 条目.path)
            : typeof 内容 === "string"
              ? { srcDoc: 内容, rawUrl: "" }
              : {
                  srcDoc: String(内容?.srcDoc || 内容?.content || 内容?.html || 内容?.text || ""),
                  rawUrl: String(内容?.rawUrl || 内容?.url || ""),
                };
          项们.push({ 条目, 板 });
        }
        const 多板 = 项们.length > 1;
        if (多板) {
          const 首 = 项们[0].条目;
          const 异尺寸 = 项们.find((项) => Math.round(项.条目.w) !== Math.round(首.w) || Math.round(项.条目.h) !== Math.round(首.h));
          if (异尺寸 && 导出格式 === "pdf") {
            throw new Error(`PDF 多板导出要求画板同尺寸；「${异尺寸.条目.title || 异尺寸.条目.path}」与首板尺寸不同，请逐板导出 PNG`);
          }
        }
        if (画布.title) document.title = `${画布.title}${多板 ? " · 导出" : ` · ${项们[0].条目.title}`}`;
        set数据({ 画布, 项们, 多板 });
        set状态("就绪");
      } catch (异常) {
        if (取消) return;
        const 消息 = String(异常?.message || "读取画布失败");
        标错(消息);
        set错误(消息);
        set状态("失败");
      }
    })();
    return () => {
      取消 = true;
      window.__OAW_EXPORT_READY = false;
      window.__OAW_EXPORT_ERROR = "";
    };
  }, []);

  // 渲染稳定后再置 READY：等视口 → 等图片/兼容板 → 等字体 → 注入 @page → 开门
  useEffect(() => {
    if (!数据) return undefined;
    let 取消 = false;
    (async () => {
      await 等待视口稳定();
      if (取消) return;
      // 两帧之后 React 已经把板画进 DOM（含 transform 缩放）
      await new Promise((完成) => requestAnimationFrame(() => requestAnimationFrame(完成)));
      await 等待图片(容器引用.current);
      await 等待框架(容器引用.current);
      try {
        await document.fonts?.ready;
      } catch {
        /* 字体 API 不可用时直接继续 */
      }
      if (取消) return;
      // @page 与板同尺寸：PDF 按板逐页分页（同尺寸，首板决定纸张尺寸）
      const 首 = 数据.项们[0].条目;
      const 宽 = Math.round(首.w * 导出缩放);
      const 高 = Math.round(首.h * 导出缩放);
      const 页样式 = document.createElement("style");
      页样式.textContent = `@page { size: ${宽}px ${高}px; margin: 0; }`;
      document.head.appendChild(页样式);
      window.__OAW_EXPORT_READY = true;
    })();
    return () => {
      取消 = true;
    };
  }, [数据]);

  if (!数据) {
    return (
      <div className="oaw-canvas-export-page" role="status" aria-label="创作画布导出视图">
        {状态 === "失败" ? <div className="oaw-canvas-export-error">{错误}</div> : null}
      </div>
    );
  }

  const 素材前缀 = `/api/canvas/${encodeURIComponent(画布标识)}/asset?${工作区 ? `workspace=${encodeURIComponent(工作区)}&` : ""}path=`;

  const 渲染页 = ({ 条目, 板 }, 索引) => {
    const 宽 = Math.round(条目.w * 导出缩放);
    const 高 = Math.round(条目.h * 导出缩放);
    // 多板 PDF：每页与首板同尺寸，按比例缩放到页内（同尺寸板即 1:1）
    const 首 = 数据.项们[0].条目;
    const 页缩放 = 数据.多板 ? Math.min(1, 首.w / Math.max(条目.w, 1), 首.h / Math.max(条目.h, 1)) : 1;
    return (
      <div
        key={`${条目.path}:${索引}`}
        className={`oaw-canvas-export-page${数据.多板 ? " is-stack" : ""}`}
        style={{ width: 宽, height: 高 }}
        data-board={条目.path}
      >
        {条目.type === "object" ? (
          <div
            className="oaw-canvas-export-board"
            style={{ width: 条目.w, height: 条目.h, background: 板.background || undefined, transform: `scale(${导出缩放 * 页缩放})` }}
          >
            {板.elements.map((元素) => (
              <导出元素 key={元素.id} 元素={元素} 素材前缀={素材前缀} />
            ))}
          </div>
        ) : 板.srcDoc ? (
          <iframe
            className="oaw-canvas-export-frame"
            title={`兼容板 ${条目.title}`}
            /* 安全边界：只开 allow-same-origin，不开脚本权限，兼容板内脚本不会执行 */
            sandbox="allow-same-origin"
            srcDoc={板.srcDoc}
            referrerPolicy="no-referrer"
            style={{ width: 条目.w, height: 条目.h, transform: `scale(${导出缩放 * 页缩放})` }}
          />
        ) : 板.rawUrl ? (
          <iframe
            className="oaw-canvas-export-frame"
            title={`兼容板 ${条目.title}`}
            sandbox="allow-same-origin"
            src={板.rawUrl}
            referrerPolicy="no-referrer"
            style={{ width: 条目.w, height: 条目.h, transform: `scale(${导出缩放 * 页缩放})` }}
          />
        ) : 条目.type === "svg" ? (
          <img
            className="oaw-canvas-export-frame"
            src={素材地址({ slug: 画布标识, workspace: 工作区, path: 条目.path })}
            alt=""
            draggable={false}
            style={{ width: 条目.w, height: 条目.h, transform: `scale(${导出缩放 * 页缩放})` }}
          />
        ) : (
          <div className="oaw-canvas-export-error">兼容板内容未返回：需要板接口给出 HTML 正文（srcDoc）或受控地址（rawUrl）</div>
        )}
      </div>
    );
  };

  return (
    <div className={数据.多板 ? "oaw-canvas-export-stack" : undefined} ref={容器引用}>
      {数据.项们.map(渲染页)}
    </div>
  );
}
