/**
 * 地图项目服务：项目读取/样式保存/图层导入/瓦片重建
 *
 * 目录结构（office-workspace/maps/{project}/）:
 *   map.config.json   项目配置（名称/中心/底图/图层清单）
 *   style.json        MapLibre 样式（sources 用相对瓦片 URL）
 *   layers/*.geojson  图层数据
 *   tiles/{layer}/{z}/{x}/{y}.pbf  矢量瓦片（生成产物）
 *
 * 静态文件由 index.mjs 挂载: /api/map/data/* → maps 根目录
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_DIR } from "./workspace.mjs";
import { LAYER_DEFS, GROUP_BY_TYPE, buildProjectTiles } from "../scripts/lib/tiler.mjs";
import { atomicWriteJson, appendJsonLine } from "./持久化工具.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_ROOT = path.join(WORKSPACE_DIR, "maps");
export const DEFAULT_PROJECT = "zhejiang-map";
/** 工程配置版本：v2 起带基线/图层元数据/操作日志 */
export const MAP_SCHEMA_VERSION = 2;
const BASELINE_FILE = "map.baseline.json";
const OPERATIONS_FILE = "operations.jsonl";
const TRASH_DIR = ".trash";
// 项目内 agent 生成内容归档：manifest.jsonl + reports/ + exports/
const AGENT_DIR = "agent";
const AGENT_MANIFEST_FILE = "manifest.jsonl";
// 文件树跳过的大目录（瓦片/回收站），避免一次列目录读入上万个文件
const PROJECT_TREE_SKIP_DIRS = new Set(["tiles", ".trash", "node_modules"]);

// 字形地址（单一定义）：自托管到 /glyphs/，由 client/public/glyphs 提供
// （scripts/生成地图字形.mjs 生成）。改这里即可全项目生效。
export const GLYPHS_URL = "/glyphs/{fontstack}/{range}.pbf";

export const STATIC_ROOT = MAPS_ROOT; // index.mjs 静态挂载点

// 基础底图（始终可用）：高德 3 档，国内 CDN 稳定、CORS 全开
// style=8 路网（含道路注记） / style=6 卫星影像 / style=7 卫星影像+注记
const GAODE_BASEMAPS = {
  "gaode-road": {
    name: "高德路网",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
  "gaode-sat": {
    name: "高德卫星",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst03.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      "https://webst04.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
  "gaode-sat-label": {
    name: "高德卫星注记",
    type: "raster",
    tileSize: 256,
    tiles: [
      "https://webst01.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst02.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst03.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
      "https://webst04.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}",
    ],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  },
};

// 公开免 Key 栅格底图。OpenFreeMap 的 Liberty/Bright/Fiord 是完整 MapLibre
// 矢量样式，直接作为单个 raster source 会替换项目图层，因此不在此列表中。
function noKeyBasemaps() {
  return {
    "osm-standard": {
      name: "OSM 标准",
      type: "raster",
      tileSize: 256,
      maxzoom: 19,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
    "carto-positron": {
      name: "CARTO 浅色",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "carto-dark": {
      name: "CARTO 暗色",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "carto-voyager": {
      name: "CARTO Voyager",
      type: "raster",
      tileSize: 256,
      maxzoom: 20,
      tiles: ["https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"],
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    opentopomap: {
      name: "OpenTopoMap 地形",
      type: "raster",
      tileSize: 256,
      maxzoom: 17,
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      attribution: '&copy; <a href="https://opentopomap.org/">OpenTopoMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    "tencent-road": {
      name: "腾讯路网（GCJ-02）",
      type: "raster",
      tileSize: 256,
      maxzoom: 18,
      scheme: "tms",
      tiles: [
        "https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt1.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt2.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
        "https://rt3.map.gtimg.com/tile?z={z}&x={x}&y={y}&type=vector&styleid=0",
      ],
      attribution: '&copy; <a href="https://map.qq.com/">腾讯地图</a>（GCJ-02）',
    },
    "tencent-satellite": {
      name: "腾讯卫星（GCJ-02）",
      type: "raster",
      tileSize: 256,
      maxzoom: 18,
      scheme: "tms",
      tiles: [
        "https://p0.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p1.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p2.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
        "https://p3.map.gtimg.com/sateTiles/{z}/{x}/{y}.jpg",
      ],
      attribution: '&copy; <a href="https://map.qq.com/">腾讯地图</a>（GCJ-02）',
    },
  };
}

// 底图设置（maps/settings.json）：各底图服务 Key
const MAP_SETTINGS_PATH = path.join(MAPS_ROOT, "settings.json");
// 密钥只写入 settings.local.json（被 .gitignore 忽略），避免误提交到仓库。
const MAP_SETTINGS_LOCAL_PATH = path.join(MAPS_ROOT, "settings.local.json");
const DEFAULT_MAP_SETTINGS = { basemaps: { tiandituKey: "", maptilerKey: "", geoapifyKey: "", esriToken: "" } };

export function loadMapSettings() {
  const raw = readJson(MAP_SETTINGS_PATH, null);
  const local = readJson(MAP_SETTINGS_LOCAL_PATH, null);
  return {
    basemaps: {
      ...DEFAULT_MAP_SETTINGS.basemaps,
      ...(raw?.basemaps || {}),
      ...(local?.basemaps || {}),
    },
  };
}

export function saveMapSettings(basemaps = {}) {
  const cur = loadMapSettings();
  cur.basemaps = {
    tiandituKey: String(basemaps.tiandituKey ?? cur.basemaps.tiandituKey ?? ""),
    maptilerKey: String(basemaps.maptilerKey ?? cur.basemaps.maptilerKey ?? ""),
    geoapifyKey: String(basemaps.geoapifyKey ?? cur.basemaps.geoapifyKey ?? ""),
    esriToken: String(basemaps.esriToken ?? cur.basemaps.esriToken ?? ""),
  };
  fs.mkdirSync(MAPS_ROOT, { recursive: true });
  writeJsonAtomic(MAP_SETTINGS_LOCAL_PATH, JSON.stringify({ basemaps: cur.basemaps }, null, 2));
  return cur;
}

// Esri 免费底图（World_Imagery / World_Street_Map，无需 Key）
function esriBasemaps() {
  return {
    "esri-sat": {
      name: "Esri 卫星",
      type: "raster",
      tileSize: 256,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    },
    "esri-street": {
      name: "Esri 街道",
      type: "raster",
      tileSize: 256,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"],
      attribution: '&copy; Esri, HERE, Garmin, OpenStreetMap contributors',
    },
  };
}

// 天地图 WMTS（XYZ 风格），需用户填 tk；子域 t0-t7
function tiandituBasemaps(key) {
  const tk = encodeURIComponent(key);
  const hosts = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
  const wmts = (layer, matrix) =>
    hosts.map(
      (h) =>
        `https://${h}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=${matrix}&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tk}`
    );
  return {
    "tianditu-vec": {
      name: "天地图矢量",
      type: "raster",
      tileSize: 256,
      tiles: wmts("vec", "w"),
      attribution: '&copy; <a href="https://www.tianditu.gov.cn/">天地图</a>',
    },
    "tianditu-img": {
      name: "天地图影像",
      type: "raster",
      tileSize: 256,
      tiles: wmts("img", "w"),
      attribution: '&copy; <a href="https://www.tianditu.gov.cn/">天地图</a>',
    },
  };
}

// MapTiler XYZ，需用户填 Key。
// 当前项目统一使用无标注参数，避免底图自带地名与项目中文标注重复。
function maptilerBasemaps(key) {
  const k = encodeURIComponent(key);
  const raster = (name, mapId, ext = "png") => ({
    name,
    type: "raster",
    tileSize: 256,
    tiles: [`https://api.maptiler.com/maps/${mapId}/{z}/{x}/{y}.${ext}?key=${k}&language=none`],
    attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  return {
    "maptiler-streets": raster("MapTiler 街道（无标注）", "streets-v2"),
    "maptiler-satellite": {
      ...raster("MapTiler 卫星（无标注）", "satellite-v2", "jpg"),
      tiles: [`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${k}&language=none`],
    },
    "maptiler-hybrid": raster("MapTiler 卫星混合（无标注）", "hybrid", "jpg"),
    "maptiler-outdoor": raster("MapTiler 户外地形（无标注）", "outdoor-v2"),
    "maptiler-winter": raster("MapTiler 冬季地形（无标注）", "winter-v2"),
    "maptiler-basic": raster("MapTiler 简洁底图（无标注）", "basic-v2"),
  };
}

/** 按设置生成可用底图源（免 Key 源固定，天地图/MapTiler 填 Key 后启用） */
function markBasemap(s) {
  return { ...s, metadata: { ...(s.metadata || {}), basemap: true } };
}
export function getBasemaps(settings = loadMapSettings()) {
  let b = {};
  b.blank = markBasemap({ name: "无底图", type: "raster", tileSize: 256, tiles: [], attribution: "" });
  for (const [id, s] of Object.entries(GAODE_BASEMAPS)) b[id] = markBasemap(s);
  for (const [id, s] of Object.entries(noKeyBasemaps())) b[id] = markBasemap(s);
  for (const [id, s] of Object.entries(esriBasemaps())) b[id] = markBasemap(s);
  const tk = settings?.basemaps?.tiandituKey;
  if (tk) for (const [id, s] of Object.entries(tiandituBasemaps(tk))) b[id] = markBasemap(s);
  const mk = settings?.basemaps?.maptilerKey;
  if (mk) for (const [id, s] of Object.entries(maptilerBasemaps(mk))) b[id] = markBasemap(s);
  return b;
}

/** 图层默认样式（与 LAYER_DEFS 对齐，Agent 可改 style.json 覆盖） */
function layerStyle(def) {
  const base = { id: def.id, source: def.id, "source-layer": def.id, layout: { visibility: "visible" } };
  switch (def.type) {
    case "boundary":
      return {
        ...base,
        type: "line",
        paint: {
          "line-color": def.id === "boundary-city" ? "#e4572e" : "#b8b8c8",
          "line-width": def.id === "boundary-city" ? 2 : ["interpolate", ["linear"], ["zoom"], 7, 0.8, 10, 1.3, 13, 1.8],
          "line-opacity": 0.9,
          "line-dasharray": def.id === "boundary-city" ? [1, 0] : [2, 1.2],
        },
      };
    case "road":
      return {
        ...base,
        type: "line",
        paint: {
          "line-color": def.id === "highways" ? "#d62728" : def.id === "roads-rural" ? "#2ca02c" : "#ff7f0e",
          "line-width": def.id === "highways" ? ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2.5, 13, 4.5] : ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.8, 13, 3.2],
          "line-opacity": 0.85,
        },
      };
    case "point":
      return {
        ...base,
        type: "circle",
        paint: {
          "circle-radius": def.id === "toll-stations" ? 4 : 4.5,
          "circle-color": def.id === "toll-stations" ? "#2ca02c" : "#9467bd",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      };
    default:
      return base;
  }
}

// 地图标注字体（glyphs）。历史域名 glyphs.openfreestyle.com 已失效（DNS 无解析），
// 会导致道路编号/地名等 symbol 图层取不到字形。改用 MapLibre 官方字形服务，
// 其 Noto Sans Regular 同时覆盖拉丁与 CJK 区段。
const DEFAULT_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
const DEAD_GLYPH_HOSTS = ["glyphs.openfreestyle.com"];

function getDefaultStyle(project, baseProject = null, { includeBusiness = true } = {}) {
  const basemaps = getBasemaps();
  const sources = { ...basemaps };
  const sourceProject = baseProject || project;
  if (includeBusiness) {
    for (const def of LAYER_DEFS) {
      sources[def.id] = {
        type: "vector",
        // 绝对路径：MapLibre 不解析 sources.tiles 的相对 URL
        tiles: [`/api/map/data/${sourceProject}/tiles/${def.id}/{z}/{x}/{y}.pbf`],
        maxzoom: def.maxzoom,
      };
    }
  }
  // 底图栅格图层：切换底图 = 切换显隐，无需整样式重载
  const DEFAULT_BASEMAP = "gaode-road";
  const basemapLayers = Object.keys(basemaps).map((id) =>
    id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        }
  );
  const layers = [
    ...basemapLayers,
    ...(includeBusiness ? LAYER_DEFS.map(layerStyle) : []),
  ];
  return {
    version: 8,
    name: `${project} 地图样式`,
    sources,
    layers,
    // 自托管字形：原先指向 glyphs.openfreestyle.com（域名已无法解析），
    // 导致 15 个标注图层（道路注记、行政区名）全部缺字形。
    glyphs: GLYPHS_URL,
  };
}

function defaultConfig(project, { name = null, baseProject = null, blank = false } = {}) {
  const now = new Date().toISOString();
  const layers = blank ? [] : LAYER_DEFS.map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    group: d.group || GROUP_BY_TYPE[d.type] || "其他",
    visible: true,
    opacity: 1,
    minzoom: d.minzoom,
    maxzoom: d.maxzoom,
    locked: false,
    source: { kind: "builtin", path: "", format: "geojson", importedAt: now },
  }));
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    kind: blank ? "blank" : "project",
    name: name || (project === "zhejiang-map" ? "浙江省交通路网与区划图" : project),
    project,
    description: "",
    archived: false,
    // 基础路网可复用已有项目；业务图层、配置和 Run 产物仍归当前项目。
    baseProject: baseProject && baseProject !== project ? baseProject : null,
    crs: "EPSG:4326",
    center: blank ? [120.07, 29.31] : [120.0, 29.2],
    zoom: blank ? 9 : 7,
    basemap: "gaode-road",
    groups: [...new Set(layers.map((l) => l.group))].map((group) => ({ name: group, collapsed: false })),
    sharedLayers: [],
    layers,
    bookmarks: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 项目目录（防目录穿越） */
export function projectDir(name = DEFAULT_PROJECT) {
  const n = String(name || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(n)) return null;
  return path.join(MAPS_ROOT, n);
}

export function listProjects() {
  if (!fs.existsSync(MAPS_ROOT)) return [];
  return fs
    .readdirSync(MAPS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(MAPS_ROOT, e.name, "map.config.json")))
    .map((e) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, e.name, "map.config.json"), "utf8"));
      } catch {
        return { project: e.name, name: e.name };
      }
    });
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// ---- Windows 并发读写防护 ----
// style.json / map.config.json 会被前端地图每几秒轮询，同时被 agent 与前端写回。
// writeFileSync 原地截断在 Windows 上与并发读冲突时抛 UNKNOWN（共享冲突），
// 曾导致样式接口 500、地图端「加载失败」与进程崩溃重启。
// 统一走「临时文件 + rename 重试」原子写；读取侧短重试并保留最后好样式兜底。
const IO_RETRY_CODES = new Set(["UNKNOWN", "EPERM", "EACCES", "EBUSY", "EMFILE"]);

function isTransientIoError(e) {
  return IO_RETRY_CODES.has(String(e?.code || ""));
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 平台不支持时退化为忙等一档 */ }
}

function renameWithRetry(tmp, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      // 目标文件正被读取的瞬间 rename 会短暂失败；重试后仍失败则回退原地写（保底不丢数据）。
      if (attempt >= 4 || !isTransientIoError(e)) {
        try { fs.copyFileSync(tmp, target); fs.unlinkSync(tmp); } catch { /* 回退失败时保留 tmp 便于排查 */ }
        return;
      }
      sleepSync(30 * 2 ** attempt);
    }
  }
}

/** 原子写 JSON/文本：临时文件 + rename，读方要么看到旧文件要么看到新文件，不会读到半截。 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  renameWithRetry(tmp, file);
}

// 最后好样式缓存：读取遭遇瞬时锁冲突时兜底返回上一份成功解析的样式，避免前端样式轮询 500。
const styleGoodCache = new Map();

function readStyleResilient(stylePath, projectName) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const style = JSON.parse(fs.readFileSync(stylePath, "utf8"));
      styleGoodCache.set(projectName, style);
      return style;
    } catch (e) {
      lastErr = e;
      if (e?.code === "ENOENT") break; // 文件真不存在：重试无意义
      if (attempt < 3 && isTransientIoError(e)) sleepSync(40 * 2 ** attempt);
    }
  }
  const cached = styleGoodCache.get(projectName);
  if (cached) return cached;
  throw lastErr || new Error("style read failed");
}

/** 供 /api/map/data/:project/style.json 使用：短重试 + 最后好样式兜底。 */
export function readProjectStyleResilient(name) {
  const dir = projectDir(name);
  if (!dir) throw new Error("invalid project name");
  return readStyleResilient(path.join(dir, "style.json"), name);
}

// 样式文件可能被提交到仓库，持久化时把底图服务凭证替换为占位符。
// 运行时由 /api/map/data/:project/style.json 注入真实 URL，因此地图仍可正常加载。
function redactBasemapCredentials(style) {
  const out = { ...style, sources: { ...(style?.sources || {}) } };
  for (const [id, source] of Object.entries(out.sources)) {
    if (!source?.metadata?.basemap && !/^(maptiler|tianditu)-/.test(id)) continue;
    out.sources[id] = {
      ...source,
      tiles: Array.isArray(source.tiles)
        ? source.tiles.map((t) => String(t).replace(/([?&](?:key|tk)=)[^&]+/gi, "$1__MAP_SERVICE_KEY__"))
        : source.tiles,
    };
  }
  return out;
}

/** 将当前本地设置注入样式响应，不把凭证写回 tracked style.json。 */
export function hydrateBasemapSources(style) {
  const out = { ...style, sources: { ...(style?.sources || {}) } };
  const runtime = getBasemaps();
  for (const [id, source] of Object.entries(runtime)) out.sources[id] = source;
  // 运行时保护：移除已不可用的底图 source。典型场景是未配置 MapTiler Key 时，
  // 历史样式里残留的 maptiler-* 仍带着占位符 Key 请求瓦片，上游返回 403，
  // 用户看到的是空白/错误底图。底图一律以 getBasemaps() 为唯一事实来源。
  const runtimeBasemapIds = new Set(Object.keys(runtime));
  for (const [id, source] of Object.entries(out.sources)) {
    const isBasemap = source?.metadata?.basemap === true || source?.basemap === true;
    if (isBasemap && !runtimeBasemapIds.has(id)) delete out.sources[id];
  }

  // 运行时保护：用户/Agent 手写的样式可能遗留非法 paint.line-cap，或引用了
  // 尚未生成的矢量瓦片。修正/剔除后再交给 MapLibre，避免整份 style 加载失败。
  const invalidSources = new Set();
  for (const [id, source] of Object.entries(out.sources)) {
    const tile = Array.isArray(source?.tiles) ? String(source.tiles[0] || "") : "";
    const match = tile.match(/\/api\/map\/data\/([^/]+)\/tiles\/([^/]+)\//);
    if (!match || source?.type !== "vector") continue;
    const [, project, layer] = match;
    const dir = projectDir(project);
    if (!dir || !fs.existsSync(path.join(dir, "tiles", layer))) {
      invalidSources.add(id);
      continue;
    }
    // 用户绘制的小图层使用 GeoJSON 更稳健，不依赖旧的 PBF 产物。
    const geojson = path.join(dir, "layers", `${layer}.geojson`);
    if (layer.startsWith("drawn-") && fs.existsSync(geojson)) {
      out.sources[id] = { type: "geojson", data: `/api/map/data/${project}/layers/${layer}.geojson` };
      for (const l of out.layers || []) if (l.source === id) delete l["source-layer"];
    }
  }
  if (invalidSources.size) {
    for (const id of invalidSources) delete out.sources[id];
    out.layers = (out.layers || []).filter((l) => !invalidSources.has(l.source));
  }
  // 样式文件可能只剩下图层引用，而数据源已经被 Agent/用户删除。
  // MapLibre 对这种悬空 source 引用会直接阻断样式加载，前端只能永久显示“地图加载中”。
  // 运行时剔除悬空图层，保留其余可用图层正常渲染；真正需要的数据可通过重新导入图层恢复。
  const sourceIds = new Set(Object.keys(out.sources || {}));
  out.layers = (out.layers || []).filter((l) => !l?.source || sourceIds.has(l.source));
  // 图层 id 必须唯一：重复 id 会让 MapLibre 判定整份样式非法（前端表现为"地图样式加载失败"）。
  // 历史导入/刷新可能写入重复定义，交给 MapLibre 前按首次出现兜底去重。
  const seenLayerIds = new Set();
  out.layers = (out.layers || []).filter((l) => {
    const id = String(l?.id || "");
    if (!id || seenLayerIds.has(id)) return false;
    seenLayerIds.add(id);
    return true;
  });
  out.layers = (out.layers || []).map((l) => {
    if (l?.paint?.["line-cap"] === undefined) return l;
    const { ["line-cap"]: cap, ...paint } = l.paint;
    return { ...l, layout: { ...(l.layout || {}), "line-cap": cap }, paint };
  });
  // 跨类型 paint 兜底：line-* 误写入 symbol/circle、text-* 误写入 line 等（Agent/用户
  // 误编辑）会让 MapLibre 校验拒绝整份样式（"unknown property"，表现为整屏加载失败）。
  // 按属性家族剔除与图层类型不匹配的键，保证交付给前端的样式永远可通过校验。
  const PAINT_FAMILY = {
    "line-": ["line"], "text-": ["symbol"], "icon-": ["symbol"], "circle-": ["circle"],
    "fill-": ["fill"], "raster-": ["raster"], "heatmap-": ["heatmap"], "hillshade-": ["hillshade"],
    "background-": ["background"],
  };
  out.layers = (out.layers || []).map((l) => {
    if (!l || !l.paint || !l.type) return l;
    const bad = Object.keys(l.paint).filter((k) => {
      const dash = k.indexOf("-") + 1;
      const fam = dash ? PAINT_FAMILY[k.slice(0, dash)] : null;
      return fam && !fam.includes(l.type);
    });
    if (!bad.length) return l;
    const paint = { ...l.paint };
    for (const k of bad) delete paint[k];
    return { ...l, paint };
  });

  // 兼容旧的 tracked style.json：新增免 Key 底图无需用户先保存一次设置，
  // 也能在动态样式响应中直接出现。缺失的底图图层插入到第一个业务图层之前，
  // 避免栅格覆盖道路、边界和分析图层。
  // 同步剔除已失效的底图图层；若原本可见的底图被移除（例如未配 Key 的 MapTiler），
  // 回退到免 Key 底图，避免出现「所有底图都隐藏」的空白画布。
  let layers = (Array.isArray(out.layers) ? [...out.layers] : []).filter((l) => {
    const lid = String(l?.id || "");
    if (!lid.startsWith("basemap-")) return true;
    return runtimeBasemapIds.has(lid.slice("basemap-".length));
  });
  const hasVisibleBasemap = layers.some((l) => String(l?.id || "").startsWith("basemap-") && l.layout?.visibility === "visible");
  if (!hasVisibleBasemap) {
    const fallbackBasemapId = runtimeBasemapIds.has("gaode-road") ? "gaode-road" : [...runtimeBasemapIds][0];
    layers = layers.map((l) => {
      const lid = String(l?.id || "");
      if (!lid.startsWith("basemap-")) return l;
      const id = lid.slice("basemap-".length);
      return { ...l, layout: { ...(l.layout || {}), visibility: id === fallbackBasemapId ? "visible" : "none" } };
    });
  }
  out.layers = layers;
  const baseIds = new Set(layers.filter((l) => String(l?.id || "").startsWith("basemap-")).map((l) => String(l.id).slice("basemap-".length)));
  const visibleId = layers.find((l) => String(l?.id || "").startsWith("basemap-") && l.layout?.visibility === "visible")?.id?.slice("basemap-".length) || "gaode-road";
  const missing = Object.keys(runtime).filter((id) => !baseIds.has(id));
  if (missing.length) {
    const insertAt = layers.findIndex((l) => !String(l?.id || "").startsWith("basemap-"));
    const baseLayers = missing.map((id) => id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === visibleId ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === visibleId ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        });
    layers.splice(insertAt < 0 ? layers.length : insertAt, 0, ...baseLayers);
    out.layers = layers;
  }
  // 字体服务同样以运行时配置为准：历史样式里写死的失效域名会被纠正，
  // 否则道路编号/地名等标注图层全部取不到字形。
  const glyphsUrl = String(out.glyphs || "");
  if (!glyphsUrl || DEAD_GLYPH_HOSTS.some((host) => glyphsUrl.includes(host))) out.glyphs = DEFAULT_GLYPHS;
  return out;
}

/* ================= 工程化底座：迁移 / 备份 / 基线 / 日志 / 回收站 ================= */

const layerStatsCache = new Map();

function isoNow() {
  return new Date().toISOString();
}

function uniqueGroups(layers = []) {
  return [...new Set(layers.map((l) => String(l?.group || "其他")))].map((name) => ({ name, collapsed: false }));
}

/** 把任意历史 config 归一化为 v2 形状；changed=true 表示需要落盘迁移。 */
export function normalizeConfig(name, raw = null) {
  const defaults = defaultConfig(name);
  const config = { ...defaults, ...(raw || {}) };
  const defs = new Map(LAYER_DEFS.map((d) => [String(d.id), d]));
  if (Array.isArray(raw?.layers)) {
    config.layers = raw.layers.map((l) => {
      const id = String(l?.id || "");
      const def = defs.get(id);
      const type = l?.type || def?.type || "fill";
      return {
        ...l,
        id,
        name: l?.name || def?.name || id || "未命名图层",
        type,
        group: l?.group || def?.group || GROUP_BY_TYPE[type] || "其他",
        visible: l?.visible !== false,
        opacity: typeof l?.opacity === "number" ? l.opacity : 1,
        minzoom: Number.isFinite(l?.minzoom) ? l.minzoom : (def?.minzoom ?? 5),
        maxzoom: Number.isFinite(l?.maxzoom) ? l.maxzoom : (def?.maxzoom ?? 13),
        locked: Boolean(l?.locked),
        source: l?.source || {
          kind: def ? "builtin" : "import",
          path: def ? "" : `layers/${id}.geojson`,
          format: "geojson",
          importedAt: config.createdAt || isoNow(),
        },
      };
    });
  }
  config.groups = Array.isArray(raw?.groups) && raw.groups.length
    ? raw.groups.map((g) => (typeof g === "string"
      ? { name: g, collapsed: false }
      : { name: String(g?.name || "其他"), collapsed: Boolean(g?.collapsed) }))
    : uniqueGroups(config.layers);
  if (!config.schemaVersion) config.schemaVersion = MAP_SCHEMA_VERSION;
  if (!config.crs) config.crs = "EPSG:4326";
  if (!config.createdAt) config.createdAt = config.updatedAt || isoNow();
  if (!config.updatedAt) config.updatedAt = config.createdAt;
  if (typeof config.description !== "string") config.description = "";
  if (!Array.isArray(config.sharedLayers)) config.sharedLayers = [];
  if (!Array.isArray(config.bookmarks)) config.bookmarks = [];
  const changed = JSON.stringify(config) !== JSON.stringify(raw || {});
  return { config, changed };
}

/** 写前保留最近一次备份（覆盖式 .bak，便于人工恢复）。 */
function backupFile(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不阻断主写入 */ }
}

/** 原子写 config：自动补 updatedAt 并保留备份。 */
export function writeConfig(name, config) {
  const dir = projectDir(name);
  if (!dir) return null;
  const next = { ...config, schemaVersion: config?.schemaVersion || MAP_SCHEMA_VERSION, updatedAt: isoNow() };
  const target = path.join(dir, "map.config.json");
  fs.mkdirSync(dir, { recursive: true });
  backupFile(target);
  atomicWriteJson(target, next);
  return next;
}

/** 原子写 style：保留备份，凭证照旧脱敏。 */
export function writeStyle(name, style) {
  const dir = projectDir(name);
  if (!dir || !style || typeof style !== "object") return null;
  const target = path.join(dir, "style.json");
  fs.mkdirSync(dir, { recursive: true });
  backupFile(target);
  atomicWriteJson(target, redactBasemapCredentials(style));
  return true;
}

function baselinePath(name) {
  const dir = projectDir(name);
  return dir ? path.join(dir, BASELINE_FILE) : null;
}

function pickBaselineLayer(layer = {}) {
  return {
    id: String(layer.id || ""),
    name: layer.name,
    type: layer.type,
    group: layer.group,
    visible: layer.visible !== false,
    opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
    minzoom: layer.minzoom,
    maxzoom: layer.maxzoom,
    locked: Boolean(layer.locked),
    origin: layer.origin,
    owner: layer.owner,
  };
}

/** 读取项目基线；不存在返回 null。 */
export function getBaseline(name = DEFAULT_PROJECT) {
  const p = baselinePath(name);
  if (!p || !fs.existsSync(p)) return null;
  const baseline = readJson(p, null);
  if (!baseline || !Array.isArray(baseline.layers)) return null;
  return baseline;
}

/** 把当前 config/style 固化为项目基线。 */
export function setBaseline(name = DEFAULT_PROJECT, { actor = "user" } = {}) {
  const dir = projectDir(name);
  if (!dir) return null;
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const style = readJson(path.join(dir, "style.json"), null) || getDefaultStyle(name, config.baseProject);
  const styleState = {};
  for (const layer of Array.isArray(style.layers) ? style.layers : []) {
    const id = String(layer?.id || "");
    if (!id || id.startsWith("basemap-") || id === "basemap-blank") continue;
    styleState[id] = {
      layout: layer.layout || {},
      paint: layer.paint || {},
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
    };
  }
  const baseline = {
    schemaVersion: MAP_SCHEMA_VERSION,
    project: String(config.project || name),
    createdAt: isoNow(),
    groups: config.groups,
    layers: config.layers.map(pickBaselineLayer),
    style: styleState,
  };
  fs.mkdirSync(dir, { recursive: true });
  backupFile(baselinePath(name));
  atomicWriteJson(baselinePath(name), baseline);
  logOperation(name, { action: "baseline.set", actor, detail: { layers: baseline.layers.length } });
  return baseline;
}

/** 把基线状态回填到 config/style（不改图层数据）。 */
function applyBaseline(name, baseline, { keepExtra = true } = {}) {
  const dir = projectDir(name);
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const currentById = new Map((config.layers || []).map((l) => [String(l.id), l]));
  const baselineIds = new Set((baseline.layers || []).map((l) => String(l.id)));
  const extraIds = new Set((config.layers || []).filter((l) => !baselineIds.has(String(l.id))).map((l) => String(l.id)));
  const nextLayers = [];
  for (const b of baseline.layers || []) {
    const current = currentById.get(String(b.id));
    if (!current) continue;
    nextLayers.push({ ...current, ...pickBaselineLayer(b) });
  }
  // 基线之后新增的正式层：tree 级别保留在末尾；baseline 级别已移入回收站，不再回填。
  if (keepExtra) {
    for (const l of config.layers || []) {
      if (!baselineIds.has(String(l.id))) nextLayers.push(l);
    }
  }
  config.layers = nextLayers;
  config.groups = Array.isArray(baseline.groups) && baseline.groups.length ? baseline.groups : config.groups;
  writeConfig(name, config);

  const style = readJson(path.join(dir, "style.json"), null);
  if (style && Array.isArray(style.layers)) {
    const state = baseline.style || {};
    style.layers = style.layers.filter((layer) => !(keepExtra === false && extraIds.has(String(layer?.id || ""))));
    style.layers = style.layers.map((layer) => {
      const id = String(layer?.id || "");
      const b = state[id];
      if (!b) return layer;
      return {
        ...layer,
        layout: { ...(layer.layout || {}), ...(b.layout || {}) },
        paint: { ...(layer.paint || {}), ...(b.paint || {}) },
        minzoom: b.minzoom ?? layer.minzoom,
        maxzoom: b.maxzoom ?? layer.maxzoom,
      };
    });
    if (keepExtra === false) {
      for (const id of extraIds) if (style.sources?.[id]) delete style.sources[id];
    }
    writeStyle(name, style);
  }
  return { config, restored: nextLayers.length };
}

function stampDir(dir, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  const target = path.join(dir, TRASH_DIR, stamp);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** 把图层数据与瓦片移入项目回收站（不物理删除）。 */
function moveLayerToTrash(name, layerId, reason = "delete") {
  const dir = projectDir(name);
  if (!dir) return null;
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) return null;
  const target = stampDir(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${reason}-${safeId}`);
  const dataPath = path.join(dir, "layers", `${safeId}.geojson`);
  const tilesPath = path.join(dir, "tiles", safeId);
  if (fs.existsSync(dataPath)) fs.renameSync(dataPath, path.join(target, `${safeId}.geojson`));
  if (fs.existsSync(tilesPath)) {
    try { fs.renameSync(tilesPath, path.join(target, "tiles")); }
    catch { fs.cpSync(tilesPath, path.join(target, "tiles"), { recursive: true }); fs.rmSync(tilesPath, { recursive: true, force: true }); }
  }
  atomicWriteJson(path.join(target, "meta.json"), { layerId: safeId, reason, movedAt: isoNow() });
  return target;
}

/** 删除图层：移入回收站 + 移除 style/config 条目。 */
export function deleteLayer(name, layerId) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return { ok: false, error: "invalid layer" };
  const moved = moveLayerToTrash(name, safeId, "delete");
  const style = readJson(path.join(dir, "style.json"), getDefaultStyle(name));
  const before = style.layers.length;
  style.layers = style.layers.filter((l) => l.id !== safeId && !l.id.startsWith(`basemap-${safeId}`));
  if (style.sources?.[safeId]) delete style.sources[safeId];
  if (style.layers.length !== before) writeStyle(name, style);
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  config.layers = (config.layers || []).filter((l) => l.id !== safeId);
  writeConfig(name, config);
  logOperation(name, { action: "layer.delete", actor: "user", layerId: safeId, detail: { trash: moved } });
  return { ok: true, trash: moved };
}

/** 注册表统计的文件大小上限：超过则跳过解析，避免大图层阻塞事件循环。 */
const STATS_MAX_BYTES = 2 * 1024 * 1024;

/** 读取图层要素数与 bbox（按文件 mtime 缓存；大文件只返回体积，不解析）。 */
function layerStats(dir, layerId) {
  const file = path.join(dir, "layers", `${layerId}.geojson`);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (layerStatsCache.has(key)) return layerStatsCache.get(key);
  let stats = null;
  if (st.size > STATS_MAX_BYTES) {
    // 10–20MB 的 GeoJSON 同步 parse + 遍历坐标会让 /api/status 健康检查超时。
    // 注册表只负责元数据，大文件返回体积信息并标记 statsOmitted，由属性对话框提示。
    stats = { features: null, bbox: null, size: st.size, mtime: st.mtimeMs, statsOmitted: true };
    layerStatsCache.set(key, stats);
    return stats;
  }
  try {
    const fc = JSON.parse(fs.readFileSync(file, "utf8"));
    const features = Array.isArray(fc?.features) ? fc.features : [];
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (value) => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        const [lng, lat] = value;
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          bbox[0] = Math.min(bbox[0], lng); bbox[1] = Math.min(bbox[1], lat);
          bbox[2] = Math.max(bbox[2], lng); bbox[3] = Math.max(bbox[3], lat);
        }
        return;
      }
      value.forEach(walk);
    };
    for (const f of features) walk(f?.geometry?.coordinates);
    stats = {
      features: features.length,
      bbox: bbox[0] === Infinity ? null : bbox,
      size: st.size,
      mtime: st.mtimeMs,
    };
  } catch {
    stats = null;
  }
  layerStatsCache.set(key, stats);
  return stats;
}

/** 图层注册表：config 图层 + 磁盘统计 + 归属视图。 */
export function listLayerRegistry(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) return null;
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const baseline = getBaseline(name);
  const baselineIds = new Set((baseline?.layers || []).map((l) => String(l.id)));
  const baseDir = config.baseProject ? projectDir(config.baseProject) : null;
  const layers = (config.layers || []).map((l) => {
    const stats = layerStats(dir, String(l.id)) || (baseDir ? layerStats(baseDir, String(l.id)) : null);
    return {
      ...l,
      stats: stats || l.stats || null,
      inBaseline: baselineIds.has(String(l.id)),
    };
  });
  const counts = {
    layers: layers.length,
    features: layers.reduce((sum, l) => sum + Number(l.stats?.features || 0), 0),
    featuresOmitted: layers.filter((l) => l.stats?.statsOmitted).length,
    locked: layers.filter((l) => l.locked).length,
    addedAfterBaseline: layers.filter((l) => !l.inBaseline).length,
  };
  return {
    project: config.project || name,
    schemaVersion: config.schemaVersion,
    crs: config.crs,
    groups: config.groups,
    baselineAt: baseline?.createdAt || null,
    layers,
    counts,
  };
}

/** 更新图层元数据（名称/分组/锁定/显隐/透明度）。 */
export function updateLayerMeta(name, layerId, patch = {}) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return null;
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const layer = (config.layers || []).find((l) => String(l.id) === safeId);
  if (!layer) return null;
  const before = pickBaselineLayer(layer);
  const next = { ...layer };
  for (const key of ["name", "group", "locked", "visible", "opacity"]) {
    if (!(key in patch)) continue;
    if (key === "locked" || key === "visible") next[key] = Boolean(patch[key]);
    else if (key === "opacity") next.opacity = Math.min(1, Math.max(0, Number(patch[key]) || 0));
    else next[key] = String(patch[key] || "").trim();
  }
  config.layers = config.layers.map((l) => (String(l.id) === safeId ? next : l));
  writeConfig(name, config);
  // style 的显隐由前端 saveStyle 维护；这里仍同步一次，保证 API 单独调用也一致。
  if ("visible" in patch || "opacity" in patch) {
    const style = readJson(path.join(dir, "style.json"), null);
    if (style && Array.isArray(style.layers)) {
      style.layers = style.layers.map((l) => {
        const id = String(l?.id || "");
        if (id !== safeId && !id.startsWith(`${safeId}-`)) return l;
        const nextLayer = { ...l, layout: { ...(l.layout || {}) } };
        if ("visible" in patch) nextLayer.layout.visibility = next.visible ? "visible" : "none";
        if ("opacity" in patch && nextLayer.paint) {
          const key = ["line-opacity", "fill-opacity", "circle-opacity", "raster-opacity"].find((k) => nextLayer.paint[k] !== undefined);
          if (key) nextLayer.paint = { ...nextLayer.paint, [key]: next.opacity };
        }
        return nextLayer;
      });
      writeStyle(name, style);
    }
  }
  logOperation(name, {
    action: "layer.update",
    actor: "user",
    layerId: safeId,
    detail: { before, after: pickBaselineLayer(next) },
  });
  return { ok: true, layer: next };
}

/** 操作日志：追加写 + 读取（最新在前）。 */
export function logOperation(name, { action, actor = "user", layerId = "", detail = {}, runId = "" } = {}) {
  const dir = projectDir(name);
  if (!dir || !action) return false;
  const entry = { ts: isoNow(), project: name, action, actor, layerId: String(layerId || ""), runId: String(runId || ""), detail };
  try { appendJsonLine(path.join(dir, OPERATIONS_FILE), entry); return true; } catch { return false; }
}

export function listOperations(name = DEFAULT_PROJECT, { layerId = "", limit = 200 } = {}) {
  const dir = projectDir(name);
  if (!dir) return [];
  const file = path.join(dir, OPERATIONS_FILE);
  if (!fs.existsSync(file)) return [];
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (layerId && String(entry.layerId || "") !== String(layerId)) continue;
      out.push(entry);
    } catch { /* 跳过损坏行 */ }
  }
  return out;
}

/** agent 生成内容清单：追加写，失败不影响主流程。 */
export function appendAgentManifest(name, record = {}) {
  const dir = projectDir(name);
  if (!dir || !record?.action) return false;
  const entry = {
    ts: isoNow(),
    action: String(record.action),
    sessionId: String(record.sessionId || "").slice(0, 80),
    runId: String(record.runId || "").slice(0, 80),
    layerId: String(record.layerId || "").slice(0, 80),
    title: String(record.title || "").slice(0, 120),
    paths: Array.isArray(record.paths) ? record.paths.map((item) => String(item)).slice(0, 12) : [],
    bytes: Number(record.bytes) || 0,
  };
  try {
    const agentDir = path.join(dir, AGENT_DIR);
    fs.mkdirSync(agentDir, { recursive: true });
    appendJsonLine(path.join(agentDir, AGENT_MANIFEST_FILE), entry);
    return true;
  } catch {
    return false;
  }
}

/**
 * 项目文件树：只列项目目录内的普通文件，跳过 tiles/.trash/隐藏文件。
 * q 对“目录 + 文件名”做大小写不敏感匹配，用于按所属文件夹搜索。
 */
export function listProjectFiles(name = DEFAULT_PROJECT, { q = "", maxDepth = 4, maxFiles = 500 } = {}) {
  const dir = projectDir(name);
  if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) return null;
  const limit = Math.max(1, Math.min(2000, Number(maxFiles) || 500));
  const depthLimit = Math.max(1, Math.min(8, Number(maxDepth) || 4));
  const query = String(q || "").trim().toLowerCase();
  const files = [];
  let truncated = false;
  const walk = (current, prefix, depth) => {
    if (truncated || depth > depthLimit) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (PROJECT_TREE_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(current, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (query && !rel.toLowerCase().includes(query)) continue;
      const full = path.join(current, entry.name);
      if (!full.startsWith(dir + path.sep)) continue;
      let stat = null;
      try { stat = fs.statSync(full); } catch { continue; }
      const dirName = path.posix.dirname(rel);
      files.push({
        rel,
        name: entry.name,
        dir: dirName === "." ? "" : dirName,
        ext: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
      if (files.length >= limit) truncated = true;
    }
  };
  walk(dir, "", 1);
  return { project: String(name), files, truncated };
}

/** 三级重置：tree / temp / baseline。 */
export function resetProject(name = DEFAULT_PROJECT, level = "tree", { actor = "user" } = {}) {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "invalid project" };
  if (!["tree", "temp", "baseline"].includes(level)) {
    return { ok: false, error: "未知重置级别", code: "MAP_RESET_INVALID_LEVEL" };
  }
  // 清空临时层只动前端运行时图层，不依赖基线；另外两级必须先有基线。
  const baseline = getBaseline(name);
  if (!baseline && level !== "temp") return { ok: false, error: "项目基线不存在，请先设为基线", code: "MAP_BASELINE_MISSING" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = stampDir(dir, `${stamp}-reset-${level}`);
  for (const file of ["map.config.json", "style.json"]) {
    if (fs.existsSync(path.join(dir, file))) fs.copyFileSync(path.join(dir, file), path.join(snapshotDir, file));
  }
  if (fs.existsSync(baselinePath(name))) fs.copyFileSync(baselinePath(name), path.join(snapshotDir, BASELINE_FILE));

  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const baselineIds = new Set((baseline?.layers || []).map((l) => String(l.id)));
  const removed = [];
  if (level === "baseline") {
    for (const l of config.layers || []) {
      if (baselineIds.has(String(l.id))) continue;
      const moved = moveLayerToTrash(name, l.id, "reset-baseline");
      removed.push({ id: String(l.id), trash: moved });
    }
  }
  if (level === "temp") {
    logOperation(name, { action: "reset.temp", actor, detail: { snapshot: snapshotDir } });
    return { ok: true, level, removed, snapshot: snapshotDir, note: "临时层由前端清理" };
  }
  const applied = applyBaseline(name, baseline, { keepExtra: level !== "baseline" });
  logOperation(name, {
    action: `reset.${level}`,
    actor,
    detail: { restored: applied.restored, removed: removed.length, snapshot: snapshotDir },
  });
  return { ok: true, level, restored: applied.restored, removed, snapshot: snapshotDir };
}

export function ensureProject(name = DEFAULT_PROJECT, options = {}) {
  const dir = projectDir(name);
  if (!dir) return null;
  fs.mkdirSync(path.join(dir, "layers"), { recursive: true });
  // agent 生成内容目录：报告与导出分目录，manifest 记录每次生成来源。
  const agentDir = path.join(dir, AGENT_DIR);
  fs.mkdirSync(path.join(agentDir, "reports"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "exports"), { recursive: true });
  const manifestPath = path.join(agentDir, AGENT_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, "");
  const cfgPath = path.join(dir, "map.config.json");
  const stylePath = path.join(dir, "style.json");
  const raw = readJson(cfgPath, null);
  const { config, changed } = normalizeConfig(name, raw || defaultConfig(name, options));
  if (!raw || changed) writeConfig(name, config);
  if (!fs.existsSync(stylePath)) {
    const blank = config.kind === "blank" && !(config.layers || []).length;
    fs.writeFileSync(stylePath, JSON.stringify(redactBasemapCredentials(getDefaultStyle(name, config.baseProject, { includeBusiness: !blank })), null, 2));
  }
  return dir;
}

/** 创建独立地图项目：kind=blank 时只保留底图（AI 画布从零开始）。 */
export function createProject({ project, name = null, baseProject = DEFAULT_PROJECT, kind = "copy", description = "" } = {}) {
  const id = String(project || "").trim();
  const dir = projectDir(id);
  if (!dir) {
    const error = new Error("项目标识需为 1-64 位英文、数字、下划线或短横线，且以字母或数字开头");
    error.code = "MAP_PROJECT_INVALID";
    throw error;
  }
  if (fs.existsSync(path.join(dir, "map.config.json"))) {
    const error = new Error(`地图项目已存在：${id}`);
    error.code = "MAP_PROJECT_EXISTS";
    throw error;
  }
  const blank = kind === "blank";
  const base = String(baseProject || DEFAULT_PROJECT).trim();
  if (!blank && (!projectDir(base) || (base !== id && !fs.existsSync(path.join(projectDir(base), "map.config.json"))))) {
    const error = new Error(`基础地图项目不存在：${base}`);
    error.code = "MAP_BASE_PROJECT_NOT_FOUND";
    throw error;
  }
  const createdDir = ensureProject(id, {
    name: String(name || id).trim() || id,
    baseProject: blank ? null : (base === id ? null : base),
    blank,
  });
  if (!createdDir) throw new Error("地图项目创建失败");
  if (description) {
    const { config } = normalizeConfig(id, readJson(path.join(createdDir, "map.config.json"), null));
    config.description = String(description);
    writeConfig(id, config);
  }
  const baseline = setBaseline(id, { actor: "user" });
  logOperation(id, { action: "project.create", actor: "user", detail: { kind: blank ? "blank" : "copy", baseProject: blank ? null : base, baselineLayers: baseline?.layers?.length || 0 } });
  return getProject(id) || { config: defaultConfig(id, { name, baseProject: base }), style: getDefaultStyle(id, base), files: [] };
}

/** 递归复制目录（不依赖 fs.cpSync：Windows + Node 22 下 cpSync 存在崩溃问题）。 */
function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith("._") || entry.name.startsWith(".") && entry.name !== ".keep") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

/** 复制地图项目：保留基础路网引用与全部图层，生成独立副本。 */
export function duplicateProject({ project, name = null } = {}) {
  const source = String(project || "").trim();
  const sourceDir = projectDir(source);
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, "map.config.json"))) {
    const error = new Error(`源地图项目不存在：${source}`);
    error.code = "MAP_PROJECT_NOT_FOUND";
    throw error;
  }
  const target = String(name || `${source}-copy`).trim();
  const targetDir = projectDir(target);
  if (!targetDir) {
    const error = new Error("项目标识需为 1-64 位英文、数字、下划线或短横线");
    error.code = "MAP_PROJECT_INVALID";
    throw error;
  }
  if (fs.existsSync(path.join(targetDir, "map.config.json"))) {
    const error = new Error(`地图项目已存在：${target}`);
    error.code = "MAP_PROJECT_EXISTS";
    throw error;
  }
  copyDirRecursive(sourceDir, targetDir);
  const cfgPath = path.join(targetDir, "map.config.json");
  const config = readJson(cfgPath, {}) || {};
  config.project = target;
  config.name = `${config.name || source} 副本`;
  config.duplicatedFrom = source;
  config.duplicatedAt = new Date().toISOString();
  const normalized = normalizeConfig(target, config);
  writeConfig(target, normalized.config);
  setBaseline(target, { actor: "user" });
  logOperation(target, { action: "project.duplicate", actor: "user", detail: { source } });
  return getProject(target);
}

/** 重命名地图项目目录（默认项目不可重命名）。 */
export function renameProject({ project, name } = {}) {
  const source = String(project || "").trim();
  const target = String(name || "").trim();
  if (source === DEFAULT_PROJECT) {
    const error = new Error("默认地图项目不能重命名");
    error.code = "MAP_PROJECT_PROTECTED";
    throw error;
  }
  const sourceDir = projectDir(source);
  const targetDir = projectDir(target);
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, "map.config.json"))) {
    const error = new Error(`地图项目不存在：${source}`);
    error.code = "MAP_PROJECT_NOT_FOUND";
    throw error;
  }
  if (!targetDir) {
    const error = new Error("项目标识需为 1-64 位英文、数字、下划线或短横线");
    error.code = "MAP_PROJECT_INVALID";
    throw error;
  }
  if (fs.existsSync(targetDir)) {
    const error = new Error(`目标名称已存在：${target}`);
    error.code = "MAP_PROJECT_EXISTS";
    throw error;
  }
  // Windows 上目录 rename 可能被安全软件/索引器短暂占用（EPERM/EBUSY），
  // 先退避重试，仍失败则复制后删除，保证重命名不因瞬时锁失败。
  let renamed = false;
  for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
    try {
      fs.renameSync(sourceDir, targetDir);
      renamed = true;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      if (attempt < 2) {
        const until = Date.now() + 150 * (attempt + 1);
        while (Date.now() < until) { /* 同步短退避 */ }
      }
    }
  }
  if (!renamed) {
    try {
      copyDirRecursive(sourceDir, targetDir);
      fs.rmSync(sourceDir, { recursive: true, force: true });
    } catch (error) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }
  const cfgPath = path.join(targetDir, "map.config.json");
  const config = readJson(cfgPath, {}) || {};
  config.project = target;
  config.name = String(config.name || target);
  writeConfig(target, normalizeConfig(target, config).config);
  logOperation(target, { action: "project.rename", actor: "user", detail: { from: source, to: target } });
  return getProject(target);
}

/** 归档/恢复地图项目：只改配置状态，不改目录（避免破坏会话与恢复链接）。 */
export function archiveProject(name, archived = true) {
  const dir = projectDir(name);
  if (!dir) return null;
  const cfgPath = path.join(dir, "map.config.json");
  if (!fs.existsSync(cfgPath)) return null;
  const config = readJson(cfgPath, {}) || {};
  config.archived = Boolean(archived);
  config.archivedAt = archived ? new Date().toISOString() : null;
  writeJsonAtomic(cfgPath, JSON.stringify(config, null, 2));
  return config;
}

/** 删除地图项目（默认项目受保护），移入回收目录而不是直接物理删除。 */
export function deleteProject(name) {
  const id = String(name || "").trim();
  if (id === DEFAULT_PROJECT) {
    const error = new Error("默认地图项目不能删除");
    error.code = "MAP_PROJECT_PROTECTED";
    throw error;
  }
  const dir = projectDir(id);
  if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) {
    const error = new Error(`地图项目不存在：${id}`);
    error.code = "MAP_PROJECT_NOT_FOUND";
    throw error;
  }
  const trashRoot = path.join(MAPS_ROOT, ".trash");
  fs.mkdirSync(trashRoot, { recursive: true });
  const target = path.join(trashRoot, `${id}-${Date.now().toString(36)}`);
  let moved = false;
  for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
    try {
      fs.renameSync(dir, target);
      moved = true;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      if (attempt < 2) {
        const until = Date.now() + 150 * (attempt + 1);
        while (Date.now() < until) { /* 同步短退避 */ }
      } else {
        copyDirRecursive(dir, target);
        fs.rmSync(dir, { recursive: true, force: true });
        moved = true;
      }
    }
  }
  return { deleted: id, trash: path.basename(target) };
}

/** 项目详情：config + style + 图层文件清单 */
export function getProject(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return null;
  if (!fs.existsSync(path.join(dir, "map.config.json"))) return null;
  ensureProject(name);
  const raw = readJson(path.join(dir, "map.config.json"), null);
  const { config, changed } = normalizeConfig(name, raw);
  if (changed) writeConfig(name, config);
  const style = readJson(path.join(dir, "style.json"), getDefaultStyle(name, config.baseProject));
  // 字形地址升级：存量 style.json 里固化了已失效的远程 glyphs（openfreestyle.com 无法解析），
  // 读取时就地改成本地 /glyphs/，避免逐个项目手工改文件，也避免下次写盘时又把旧值带回去。
  if (style && String(style.glyphs || "") !== GLYPHS_URL) style.glyphs = GLYPHS_URL;
  const layersDir = path.join(dir, "layers");
  const files = fs.existsSync(layersDir)
    ? fs.readdirSync(layersDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("._") && !e.name.startsWith(".") && e.name.endsWith(".geojson"))
        .map((e) => {
          const st = fs.statSync(path.join(layersDir, e.name));
          return { file: e.name, id: e.name.replace(/\.geojson$/, ""), size: st.size, mtime: st.mtimeMs };
        })
    : [];
  const basemaps = getBasemaps();
  const baseline = getBaseline(name);
  return {
    config,
    style,
    files,
    schemaVersion: config.schemaVersion,
    baselineAt: baseline?.createdAt || null,
    basemaps: Object.keys(basemaps),
    basemapMeta: Object.entries(basemaps).map(([id, s]) => ({ id, name: s.name || id })),
  };
}

export function saveStyle(name, style) {
  const dir = ensureProject(name);
  if (!dir || !style || typeof style !== "object") return null;
  writeStyle(name, style);
  return true;
}

export function saveConfig(name, config) {
  const dir = ensureProject(name);
  if (!dir || !config) return null;
  const normalized = normalizeConfig(name, config);
  writeConfig(name, normalized.config);
  return true;
}

/**
 * 按最新底图设置重建 style.json 的底图部分（保留图层自定义样式）。
 * 底图源 = id 出现在当前 getBasemaps() 里的 sources；其余 sources/图层原样保留。
 */
export function rebuildBasemapStyle(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return false;
  const stylePath = path.join(dir, "style.json");
  const basemaps = getBasemaps();
  const cfg = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  const current = cfg?.basemap;
  const DEFAULT_BASEMAP = current && basemaps[current] ? current : "gaode-road";

  let style = readJson(stylePath, null);
  if (!style || typeof style !== "object" || !style.sources) {
    writeStyle(name, getDefaultStyle(name));
    return true;
  }
  // 保留非底图 sources（底图 source 带 metadata.basemap 标记）
  const sources = {};
  for (const [id, s] of Object.entries(style.sources)) {
    if (!s?.metadata?.basemap && !s?.basemap) sources[id] = s;
  }
  Object.assign(sources, basemaps);
  // 保留非底图图层，重建 basemap-* 图层
  const keep = Array.isArray(style.layers) ? style.layers.filter((l) => !String(l.id).startsWith("basemap-")) : [];
  // 新项目只复用基础路网瓦片；导入的业务图层则在当前项目生成独立 source。
  const sourceProject = cfg?.baseProject || name;
  const configLayers = Array.isArray(cfg?.layers) ? cfg.layers : [];
  for (const layer of configLayers) {
    const id = String(layer?.id || "").trim();
    if (!id || sources[id]) continue;
    const def = LAYER_DEFS.find((item) => item.id === id) || { id, type: layer.type || "road", minzoom: layer.minzoom || 5, maxzoom: layer.maxzoom || 13 };
    sources[id] = { type: "vector", tiles: [`/api/map/data/${LAYER_DEFS.some((item) => item.id === id) ? sourceProject : name}/tiles/${id}/{z}/{x}/{y}.pbf`], maxzoom: def.maxzoom };
    if (!keep.some((item) => item.id === id)) keep.push(layerStyle(def));
  }
  const baseLayers = Object.keys(basemaps).map((id) =>
    id === "blank"
      ? {
          id: "basemap-blank",
          type: "background",
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "background-color": "rgba(0,0,0,0)" },
        }
      : {
          id: `basemap-${id}`,
          type: "raster",
          source: id,
          layout: { visibility: id === DEFAULT_BASEMAP ? "visible" : "none" },
          paint: { "raster-opacity": 1 },
        }
  );
  // 同步 config.layers 中缺失的矢量图层（数据已导入但 style 未注册，如 roads-province）
  for (const l of cfg?.layers || []) {
    const id = l.id;
    if (!sources[id]) {
      sources[id] = {
        type: "vector",
        tiles: [`/api/map/data/${name}/tiles/${id}/{z}/{x}/{y}.pbf`],
        maxzoom: l.maxzoom || 13,
      };
    }
    if (!style.layers.some((x) => x.id === id)) {
      const def = { id, type: l.type || "road", minzoom: l.minzoom || 5, maxzoom: l.maxzoom || 13 };
      keep.push(layerStyle(def));
    }
    // 道路图层自动补标号图层（显示 ref 编号，缺失回退 name），置于线图层之后
    if (l.type === "road" && !style.layers.some((x) => x.id === `${id}-label`)) {
      keep.push({
        id: `${id}-label`,
        type: "symbol",
        source: id,
        "source-layer": id,
        minzoom: (l.minzoom || 5) + 2,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "ref"], ["get", "name"], ""],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 13, 12],
          "text-font": ["Noto Sans Regular"],
          "text-rotation-alignment": "map",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.75)",
          "text-halo-width": 1.2,
        },
      });
    }
  }
  style.sources = sources;
  // 去重兜底：config 循环与磁盘 style 的判重基准不一致时可能登记同一图层 id，
  // MapLibre 不接受重复图层 id，写入前按首次出现收敛。
  const dedupedKeep = [];
  const keepIds = new Set();
  for (const l of keep) {
    const id = String(l?.id || "");
    if (id && keepIds.has(id)) continue;
    if (id) keepIds.add(id);
    dedupedKeep.push(l);
  }
  style.layers = [...baseLayers, ...dedupedKeep];
  writeStyle(name, style);
  return true;
}

/** 导入/覆盖一个 GeoJSON 图层并重建其瓦片 */
export async function importLayer(name, layerId, geojson, { actor = "user", format = "geojson" } = {}) {
  const dir = ensureProject(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return null;
  const stats = validateGeoJSON(geojson);
  const target = path.join(dir, "layers", `${safeId}.geojson`);
  const existed = fs.existsSync(target);
  // 版本快照：覆盖已有图层前把当前文件存入 versions/（每层最多 10 份，供回溯）
  if (existed) snapshotLayerVersion(dir, safeId);
  fs.writeFileSync(target, typeof geojson === "string" ? geojson : JSON.stringify(geojson));
  // 把新图层加入 config（若不存在）；已存在则补齐来源与统计。
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  const source = { kind: "import", path: `layers/${safeId}.geojson`, format, importedAt: isoNow() };
  const existing = (config.layers || []).find((l) => String(l.id) === safeId);
  if (existing) {
    existing.source = source;
    existing.stats = { features: stats.features, bbox: stats.bbox };
    existing.updatedAt = isoNow();
  } else {
    const type = guessType(geojson);
    config.layers.push({
      id: safeId,
      name: safeId,
      type,
      group: GROUP_BY_TYPE[type] || "其他",
      visible: true,
      opacity: 1,
      minzoom: 5,
      maxzoom: 13,
      locked: false,
      source,
      stats: { features: stats.features, bbox: stats.bbox },
      createdAt: isoNow(),
      updatedAt: isoNow(),
    });
  }
  writeConfig(name, config);
  // 重建该图层瓦片（缺 def 时按通用参数）
  const def = LAYER_DEFS.find((d) => d.id === safeId) || { id: safeId, minzoom: 5, maxzoom: 13, tolerance: 0.0001 };
  const r = buildProjectTiles(dir, { layerIds: [safeId], force: true, defs: [def] });
  // 导入后立即把新图层注册到 style，确保前端可见性复选框和 Agent 产物都能正常显示/隐藏。
  rebuildBasemapStyle(name);
  logOperation(name, {
    action: existed ? "layer.overwrite" : "layer.import",
    actor,
    layerId: safeId,
    detail: { features: stats.features, bbox: stats.bbox, format },
  });
  return { ok: true, layer: safeId, features: stats.features, bbox: stats.bbox, tiles: r[safeId] };
}

/** 替换图层数据：旧数据与瓦片先入回收站，再按同 id 导入并重建。 */
export async function replaceLayer(name, layerId, geojson, { actor = "user", format = "geojson" } = {}) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return { ok: false, error: "invalid layer" };
  const { config } = normalizeConfig(name, readJson(path.join(dir, "map.config.json"), null));
  if (!(config.layers || []).some((l) => String(l.id) === safeId)) return { ok: false, error: "layer not found" };
  const discarded = moveLayerToTrash(name, safeId, "replace");
  const imported = await importLayer(name, safeId, geojson, { actor, format });
  logOperation(name, { action: "layer.replace", actor, layerId: safeId, detail: { discarded } });
  return { ...imported, discarded };
}

function validateGeoJSON(geojson) {
  let fc = geojson;
  if (typeof fc === "string") fc = JSON.parse(fc);
  if (fc?.type === "Feature") fc = { type: "FeatureCollection", features: [fc] };
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.length) {
    throw new Error("没有可导入的要素（需要非空 FeatureCollection）");
  }
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let coordinates = 0;
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      const [lng, lat] = value;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("图层包含无效坐标");
      if (Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error("坐标不在经纬度范围内，请先转换为 WGS84/EPSG:4326");
      bbox[0] = Math.min(bbox[0], lng); bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lng); bbox[3] = Math.max(bbox[3], lat);
      coordinates += 1;
      return;
    }
    value.forEach(walk);
  };
  for (const feature of fc.features) walk(feature?.geometry?.coordinates);
  if (!coordinates || bbox[0] === Infinity) throw new Error("要素没有有效几何坐标");
  return { features: fc.features.length, bbox };
}

function guessType(geojson) {
  const fc = typeof geojson === "string" ? JSON.parse(geojson) : geojson;
  const g = fc?.features?.[0]?.geometry?.type;
  if (g === "Point" || g === "MultiPoint") return "point";
  if (g === "LineString" || g === "MultiLineString") return "road";
  return "boundary";
}

/** 重建全部瓦片（工具箱按钮 / 数据变更后） */
export function rebuildTiles(name = DEFAULT_PROJECT, layerIds = null) {
  const dir = ensureProject(name);
  if (!dir) return null;
  return buildProjectTiles(dir, { force: true, layerIds });
}

/** 批量导入多个图层（逐个导入，避免重复重建整套内置图层） */
export async function importBatch(name, items) {
  const results = {};
  for (const it of items || []) {
    if (!it?.geojson) continue;
    const safeId = String(it.layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) continue;
    try { results[safeId] = await importLayer(name, safeId, it.geojson); } catch { results[safeId] = { ok: false, error: "导入失败" }; }
  }
  return { ok: Object.values(results).every((result) => result?.ok), layers: results };
}

/** 读取图层原始 GeoJSON */
export function getLayer(name, layerId) {
  const dir = projectDir(name);
  const safeId = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !safeId) return null;
  const p = path.join(dir, "layers", `${safeId}.geojson`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * 一键清零：移除所有「非初始图层」（不在 config.layers 注册表中的 style 层与数据文件），
 * 注册层恢复默认样式与 config.visible 可见性，底图保持项目配置不变。
 * 数据文件不直接删除，移入项目 trash/ 目录可找回。用于把 agent/演示期间的产物一次性清干净。
 */
export function resetProjectToInitial(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) return null;
  const config = readJson(path.join(dir, "map.config.json"), null) || defaultConfig(name);
  ensureProject(name);
  const stylePath = path.join(dir, "style.json");
  const style = readJson(stylePath, null) || getDefaultStyle(name, config.baseProject);

  const registered = new Set((config.layers || []).map((l) => l.id));
  const keepLayerId = (raw) => {
    const id = String(raw);
    if (id.startsWith("basemap-")) return true;
    if (registered.has(id)) return true;
    for (const rid of registered) {
      if (id.startsWith(`${rid}-`)) return true; // 注册层的伴随层（-label 等）
    }
    return false;
  };
  const before = style.layers.length;
  style.layers = (style.layers || []).filter((l) => keepLayerId(l.id));

  // 注册层恢复默认样式与可见性（config.visible 为准；伴随层不动）
  const byId = new Map((config.layers || []).map((l) => [l.id, l]));
  style.layers = style.layers.map((l) => {
    const meta = byId.get(String(l.id));
    if (!meta) return l;
    const def = LAYER_DEFS.find((d) => d.id === meta.id) || { id: meta.id, type: meta.type };
    const fresh = layerStyle(def);
    return {
      ...l,
      type: fresh.type || l.type,
      layout: { ...(fresh.layout || {}), visibility: meta.visible === false ? "none" : "visible" },
      paint: fresh.paint || l.paint,
    };
  });

  // 清理无引用的非底图 source
  const referenced = new Set(style.layers.map((l) => l.source).filter(Boolean));
  for (const sid of Object.keys(style.sources || {})) {
    const src = style.sources[sid];
    const isBasemap = src?.metadata?.basemap || String(sid).startsWith("basemap-");
    if (!referenced.has(sid) && !isBasemap) delete style.sources[sid];
  }

  // 非注册数据文件移入回收目录（不直接删除，可找回）
  const trashDir = path.join(dir, "trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const removedFiles = [];
  const layersDir = path.join(dir, "layers");
  if (fs.existsSync(layersDir)) {
    const stamp = Date.now().toString(36);
    for (const f of fs.readdirSync(layersDir)) {
      if (!f.endsWith(".geojson")) continue;
      const id = f.replace(/\.geojson$/, "");
      if (registered.has(id)) continue;
      try {
        fs.renameSync(path.join(layersDir, f), path.join(trashDir, `${id}.${stamp}.geojson`));
        removedFiles.push(id);
      } catch { /* 单文件失败不连累整体 */ }
    }
  }

  writeJsonAtomic(stylePath, JSON.stringify(redactBasemapCredentials(style), null, 2));
  return {
    ok: true,
    removedStyleLayers: before - style.layers.length,
    removedFiles,
    keptLayers: [...registered],
  };
}

// ---------- 图层版本回溯与归档（项目级图层管理） ----------

const LAYER_VERSION_KEEP = 10;

/** 覆盖导入前快照当前图层文件到 versions/{id}.{时间戳}.geojson，每层保留最近 10 份 */
function snapshotLayerVersion(dir, id) {
  const src = path.join(dir, "layers", `${id}.geojson`);
  const verDir = path.join(dir, "versions");
  try {
    fs.mkdirSync(verDir, { recursive: true });
    const dest = path.join(verDir, `${id}.${Date.now().toString(36)}.geojson`);
    fs.copyFileSync(src, dest);
    const olds = fs.readdirSync(verDir)
      .filter((f) => f.startsWith(`${id}.`) && f.endsWith(".geojson"))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - LAYER_VERSION_KEEP))) {
      try { fs.unlinkSync(path.join(verDir, f)); } catch { /* 单文件清理失败忽略 */ }
    }
  } catch { /* 快照失败不阻断导入 */ }
}

/** 图层版本清单（新→旧） */
export function listLayerVersions(name, layerId) {
  const dir = projectDir(name);
  const id = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !id) return [];
  const verDir = path.join(dir, "versions");
  if (!fs.existsSync(verDir)) return [];
  return fs.readdirSync(verDir)
    .filter((f) => f.startsWith(`${id}.`) && f.endsWith(".geojson"))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(path.join(verDir, f));
      return { file: f, time: st.mtimeMs, size: st.size };
    });
}

/** 恢复图层到指定版本（恢复前先快照当前内容），并重建该层瓦片 */
export function restoreLayerVersion(name, layerId, file) {
  const dir = ensureProject(name);
  const id = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeFile = String(file || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!dir || !id || !safeFile) return null;
  const verPath = path.join(dir, "versions", safeFile);
  const target = path.join(dir, "layers", `${id}.geojson`);
  if (!verPath.startsWith(path.join(dir, "versions")) || !fs.existsSync(verPath)) return null;
  if (!JSON.parse(fs.readFileSync(verPath, "utf8"))) return null; // 快照必须是合法 JSON
  if (fs.existsSync(target)) snapshotLayerVersion(dir, id);
  fs.copyFileSync(verPath, target);
  const geojson = JSON.parse(fs.readFileSync(target, "utf8"));
  const config = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  if (!config.layers.some((l) => l.id === id)) {
    const type = guessType(geojson);
    config.layers.push({ id, name: id, type, group: GROUP_BY_TYPE[type] || "其他", visible: true, minzoom: 5, maxzoom: 13 });
    writeJsonAtomic(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  }
  const def = LAYER_DEFS.find((d) => d.id === id) || { id, minzoom: 5, maxzoom: 13, tolerance: 0.0001 };
  let tiles = null;
  try { tiles = buildProjectTiles(dir, { layerIds: [id], force: true, defs: [def] }); } catch { /* 瓦片失败不阻断恢复 */ }
  return { ok: true, layerId: id, restoredFrom: safeFile, tiles };
}

/** 图层归档/取消归档：归档层在 style 中隐藏（config.visible 不变），面板折叠展示可恢复 */
export function setLayerArchived(name, layerId, archived) {
  const dir = ensureProject(name);
  const id = String(layerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!dir || !id) return null;
  const config = readJson(path.join(dir, "map.config.json"), defaultConfig(name));
  const meta = (config.layers || []).find((l) => l.id === id);
  if (!meta) return null;
  meta.archived = Boolean(archived);
  meta.archivedAt = archived ? new Date().toISOString() : null;
  writeJsonAtomic(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  // style 同步显隐：归档=隐藏；取消归档=按 config.visible 恢复
  const style = readJson(path.join(dir, "style.json"), null);
  if (style?.layers) {
    const want = archived ? "none" : (meta.visible === false ? "none" : "visible");
    for (const l of style.layers) {
      if (l.id === id || (String(l.id).startsWith(`${id}-`) && String(l.id).endsWith("-label"))) {
        l.layout = { ...(l.layout || {}), visibility: want };
      }
    }
    writeJsonAtomic(path.join(dir, "style.json"), JSON.stringify(redactBasemapCredentials(style), null, 2));
  }
  return { ok: true, layerId: id, archived: meta.archived };
}

// ---------- 外部服务 ----------

/** 等时圈分析（高德 v5 isochrone）… */
export async function isochrone({ location, mode = "driving", range = 30, rangeType = "time" }) {
  const settings = loadMapSettings();
  const geoapifyKey = settings?.basemaps?.geoapifyKey || process.env.GEOAPIFY_KEY || "";
  if (geoapifyKey) return isochroneGeoapify({ location, mode, range, rangeType, key: geoapifyKey });
  const key = process.env.AMAP_KEY || process.env.GAODE_KEY || "";
  if (!key) return { error: "未配置 Geoapify 或高德等时圈 Key（可在设置中配置 Geoapify Key）" };
  const url = new URL("https://restapi.amap.com/v5/isochrone");
  url.searchParams.set("key", key);
  url.searchParams.set("location", String(location || ""));
  url.searchParams.set("mode", String(mode || "driving"));
  url.searchParams.set("range_type", String(rangeType || "time"));
  url.searchParams.set("range", String(range || 30));
  let data;
  try {
    const r = await fetch(url);
    data = await r.json();
  } catch (e) {
    return { error: "等时圈请求失败: " + e.message };
  }
  if (data.status !== "1") return { error: data.info || data.infocode || "等时圈请求失败" };
  const polygons = (data.result?.polygons || [])
    .map((p) => normalizePoints(p.points))
    .filter((pts) => pts && pts.length >= 3);
  return { error: null, center: data.result.center, cost: data.result.cost, polygons };
}

/** Geoapify Isoline API：返回 GeoJSON，统一转换为当前前端使用的外环点数组。 */
async function isochroneGeoapify({ location, mode = "driving", range = 30, rangeType = "time", key }) {
  const [lon, lat] = String(location || "").split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { error: "等时圈中心点坐标无效" };
  const modeMap = { driving: "drive", walking: "walk", bicycling: "bicycle", transit: "transit", drive: "drive", walk: "walk", bicycle: "bicycle" };
  const apiType = rangeType === "distance" ? "distance" : "time";
  const numericRange = Number(range) || 30;
  const apiRange = apiType === "distance" ? Math.round(numericRange * 1000) : Math.round(numericRange * 60);
  const url = new URL("https://api.geoapify.com/v1/isoline");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("type", apiType);
  url.searchParams.set("mode", modeMap[mode] || "drive");
  url.searchParams.set("range", String(apiRange));
  url.searchParams.set("apiKey", key);
  let data;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    data = await response.json();
    if (!response.ok) return { error: data?.message || `Geoapify 等时圈请求失败（${response.status}）` };
  } catch (e) {
    return { error: "Geoapify 等时圈请求失败: " + e.message };
  }
  const polygons = [];
  for (const feature of data?.features || []) {
    const geometry = feature?.geometry;
    if (geometry?.type === "Polygon" && geometry.coordinates?.[0]?.length >= 3) polygons.push(geometry.coordinates[0]);
    if (geometry?.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates || []) if (polygon?.[0]?.length >= 3) polygons.push(polygon[0]);
    }
  }
  if (!polygons.length) return { error: data?.message || "Geoapify 未返回有效等时圈多边形" };
  return { error: null, provider: "geoapify", center: [lon, lat], cost: null, polygons };
}

/** 高德 points 可能是 [[lng,lat],...] 或 [{lng,lat},...] 或字符串 */
function normalizePoints(points) {
  if (typeof points === "string") {
    try { points = JSON.parse(points); } catch { return null; }
  }
  if (!Array.isArray(points)) return null;
  return points.map((p) => {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === "object") return [Number(p.lng), Number(p.lat)];
    return null;
  }).filter(Boolean);
}

/**
 * 路径规划（可插拔 provider）
 * - osrm（默认）：开源 OSRM 公共服务器，零配置；也可配 OSRM_URL 指向自托管实例
 * - amap：高德 v5 direction（需 AMAP_KEY，中国路网更准）
 * 返回: { error: null, provider, distance(米), duration(秒), geometry: [[lng,lat],...] }
 */
export async function route({ from, to, mode = "driving", provider = "osrm" }) {
  if (!from || !to) return { error: "需要起点和终点坐标" };
  if (provider === "amap") return routeAmap(from, to, mode);
  return routeOsrm(from, to, mode);
}

async function routeOsrm(from, to, mode) {
  const profile = mode === "walking" ? "foot" : mode === "bicycling" ? "bike" : "driving";
  const base = process.env.OSRM_URL || "https://router.project-osrm.org";
  const url = `${base}/route/v1/${profile}/${from};${to}?overview=full&geometries=geojson&steps=false`;
  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    data = await r.json();
  } catch (e) {
    return { error: "OSRM 请求失败: " + e.message + "（可配置环境变量 OSRM_URL 指向自托管实例，或改用 provider=amap）" };
  }
  if (data.code !== "Ok" || !data.routes?.length) {
    return { error: "OSRM 未找到路径: " + (data.code || "unknown") + "（请确认两点间有路网）" };
  }
  const route0 = data.routes[0];
  return {
    error: null,
    provider: "osrm",
    distance: route0.distance,
    duration: route0.duration,
    geometry: route0.geometry?.coordinates || [],
  };
}

async function routeAmap(from, to, mode) {
  const key = process.env.AMAP_KEY || process.env.GAODE_KEY || "";
  if (!key) return { error: "未配置高德 Web 服务 Key（环境变量 AMAP_KEY），请改用默认 OSRM 开源路由" };
  const amapMode = { driving: "driving", walking: "walking", bicycling: "bicycling", transit: "transit" }[mode] || "driving";
  const url = new URL("https://restapi.amap.com/v5/direction/" + amapMode);
  url.searchParams.set("key", key);
  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("show_fields", "polyline,cost");
  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    data = await r.json();
  } catch (e) {
    return { error: "高德路径请求失败: " + e.message };
  }
  if (data.status !== "1" || !data.route?.paths?.length) {
    return { error: "高德未找到路径: " + (data.info || data.infocode || "unknown") };
  }
  const path = data.route.paths[0];
  const coords = String(path.polyline || "")
    .split(";")
    .filter(Boolean)
    .map((p) => p.split(",").map(Number));
  return {
    error: null,
    provider: "amap",
    distance: path.distance ? Number(path.distance) : 0,
    duration: path.cost?.duration ? Number(path.cost.duration) : 0,
    geometry: coords,
  };
}

// ---------- M2 宏观交通分析 ----------

/**
 * 路网流量带宽图数据
 * 返回带流量属性的高速路网 GeoJSON
 */
export function getTrafficBandwidth(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return { error: "项目不存在" };

  const hwPath = path.join(dir, "layers", "highways.geojson");
  if (!fs.existsSync(hwPath)) {
    return { error: "高速图层不存在，请先运行数据接入脚本" };
  }

  const geojson = JSON.parse(fs.readFileSync(hwPath, "utf8"));
  const features = geojson.features || [];

  // 统计流量分布
  const flows = features
    .map((f) => Number(f.properties?.flow_avg))
    .filter((value) => Number.isFinite(value) && value > 0);
  const flowStats = numericStats(flows);
  const stats = {
    count: features.length,
    withTraffic: flows.length,
    ...flowStats,
  };

  return { error: null, geojson, stats };
}

/**
 * OD 期望线数据
 * 返回模拟的市 - 县区间 OD 数据
 */
export function getODLines(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return { error: "项目不存在" };

  const odPath = path.join(dir, "layers", "OD期望线.geojson");
  if (!fs.existsSync(odPath)) {
    return { error: "OD 数据不存在，请运行 生成M2数据.mjs" };
  }

  const geojson = JSON.parse(fs.readFileSync(odPath, "utf8"));

  // 按流量分级统计
  const levels = { high: 0, medium: 0, low: 0 };
  const volumes = [];

  for (const f of geojson.features || []) {
    const level = f.properties?.level;
    if (level) levels[level] = (levels[level] || 0) + 1;
    const vol = f.properties?.volume;
    if (vol) volumes.push(vol);
  }

  const stats = {
    count: geojson.features?.length || 0,
    levels,
    volumeStats: numericStats(volumes),
  };

  return { error: null, geojson, stats };
}

/**
 * 多时距等时圈分析
 * 一次性返回多个时距的等时圈
 */
export async function multiIsochrone({ location, mode = "driving", ranges = [15, 30, 60], rangeType = "time" }) {
  if (!location) return { error: "需要中心点坐标" };
  const normalizedRanges = [...new Set((Array.isArray(ranges) ? ranges : String(ranges).split(","))
    .map(Number)
    .filter((range) => Number.isFinite(range) && range > 0))];
  if (!normalizedRanges.length) return { error: "至少需要一个有效时距" };

  const results = [];
  for (const range of normalizedRanges) {
    const r = await isochrone({ location, mode, range, rangeType });
    if (r.error) {
      return { error: r.error };
    }
    results.push({ range, ...r });
  }
  return { error: null, results };
}

/**
 * 区域交换量桑基图数据
 * 返回城市间的流量交换数据
 */
export function getExchangeSankey(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return { error: "项目不存在" };

  const sankeyPath = path.join(dir, "layers", "区域交换量.json");
  if (!fs.existsSync(sankeyPath)) {
    return { error: "区域交换量数据不存在，请运行 生成M2数据.mjs" };
  }

  const data = JSON.parse(fs.readFileSync(sankeyPath, "utf8"));

  // 计算总流量
  const totalVolume = (data.links || []).reduce((sum, l) => sum + (l.value || 0), 0);

  return {
    error: null,
    data,
    stats: {
      nodes: data.nodes?.length || 0,
      links: data.links?.length || 0,
      totalVolume,
    },
  };
}

/**
 * 路网结构统计
 * 按公路等级分类统计
 */
export function getRoadStructure(name = DEFAULT_PROJECT) {
  const dir = projectDir(name);
  if (!dir) return { error: "项目不存在" };

  const stats = {};

  for (const def of LAYER_DEFS) {
    const layerPath = path.join(dir, "layers", `${def.id}.geojson`);
    if (fs.existsSync(layerPath)) {
      const geojson = JSON.parse(fs.readFileSync(layerPath, "utf8"));
      stats[def.id] = {
        name: def.name,
        type: def.type,
        group: def.group,
        count: geojson.features?.length || 0,
      };
    }
  }

  return { error: null, stats };
}

function numericStats(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

// ---------- M3 公交数据分析 ----------

const BUS_DATA_DIR = path.join(MAPS_ROOT, "bus-xinchang");

/** 读取公交线路数据 */
export function getBusRoutes() {
  const routesPath = path.join(BUS_DATA_DIR, "routes.geojson");
  if (!fs.existsSync(routesPath)) {
    return { error: "公交线路数据不存在，请复制新昌公交数据到 maps/bus-xinchang/" };
  }
  
  const geojson = JSON.parse(fs.readFileSync(routesPath, "utf8"));
  const features = geojson.features || [];
  
  // 统计
  let urban = 0, suburban = 0, totalLength = 0;
  for (const f of features) {
    const type = f.properties?.type || "urban";
    if (type === "suburban") suburban++;
    else urban++;
    totalLength += f.properties?.length_km || 0;
  }
  
  return {
    error: null,
    geojson,
    stats: {
      total: features.length,
      urban,
      suburban,
      totalLength,
    },
  };
}

/** 读取公交站点数据 */
export function getBusStops() {
  const stopsPath = path.join(BUS_DATA_DIR, "stops.csv");
  if (!fs.existsSync(stopsPath)) {
    return { error: "站点数据不存在" };
  }
  
  const csv = fs.readFileSync(stopsPath, "utf8");
  const lines = csv.split("\n").filter(Boolean);
  const headers = lines[0].split(",");
  
  const features = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length >= 6) {
      features.push({
        type: "Feature",
        properties: {
          name: cols[0],
          route: cols[1],
          passengers: parseFloat(cols[5]) || 0,
        },
        geometry: {
          type: "Point",
          coordinates: [parseFloat(cols[3]), parseFloat(cols[2])],
        },
      });
    }
  }
  
  return {
    error: null,
    geojson: { type: "FeatureCollection", features },
    stats: { count: features.length },
  };
}

/** 读取公交 OD 数据 */
export function getBusOD(period = "all") {
  const odPath = path.join(BUS_DATA_DIR, "od.csv");
  if (!fs.existsSync(odPath)) {
    return { error: "OD 数据不存在" };
  }
  
  const csv = fs.readFileSync(odPath, "utf8");
  const lines = csv.split("\n").filter(Boolean);
  
  const features = [];
  let totalFlow = 0;
  
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length >= 10) {
      const flow = parseFloat(cols[4]) || 0;
      const timePeriod = cols[5] || "all";
      
      if (period !== "all" && timePeriod !== period) continue;
      
      totalFlow += flow;
      
      features.push({
        type: "Feature",
        properties: {
          origin: cols[0],
          dest: cols[1],
          flow,
          period: timePeriod,
        },
        geometry: {
          type: "LineString",
          coordinates: [
            [parseFloat(cols[6]), parseFloat(cols[7])],
            [parseFloat(cols[8]), parseFloat(cols[9])],
          ],
        },
      });
    }
  }
  
  return {
    error: null,
    geojson: { type: "FeatureCollection", features },
    stats: {
      pairs: features.length,
      totalFlow,
    },
  };
}

/** 公交线网统计 */
export function getBusStats() {
  const routes = getBusRoutes();
  const stops = getBusStops();
  
  if (routes.error) return routes;
  
  // 按类型分组
  const byType = {};
  for (const f of routes.geojson.features || []) {
    const type = f.properties?.type || "urban";
    byType[type] = (byType[type] || 0) + 1;
  }
  
  return {
    error: null,
    stats: {
      routes: routes.stats.total,
      stops: stops.stats?.count || 0,
      coverage: 0, // 待计算
      byType: Object.entries(byType).map(([type, count]) => ({ type, count })),
    },
  };
}
