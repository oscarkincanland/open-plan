/**
 * CSV 点表解析（GIS 导入增强 · T4.1）
 *
 * 只做一件事：识别经纬度列并把每行转成 Point 要素。
 * 支持中英文列名（经度/纬度、lng/lat、lon/lat、longitude/latitude），
 * 逗号或制表符分隔；无效坐标行跳过并计数，交给调用方提示。
 */
const CELL_SPLIT = /[,\t]/;

function cellsOf(line) {
  return String(line).split(CELL_SPLIT).map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

export function parseCsvPoints(text, name = "csv") {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const header = cellsOf(lines[0]);
  const find = (patterns) => header.findIndex((h) => patterns.some((p) => h.toLowerCase().includes(p)));
  const lngIndex = find(["经度", "lng", "lon", "longitude"]);
  const latIndex = find(["纬度", "lat", "latitude"]);
  if (lngIndex < 0 || latIndex < 0) throw new Error("CSV 未找到经纬度列（支持 经度/纬度、lng/lat、longitude/latitude）");
  const features = [];
  let invalid = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const row = cellsOf(lines[i]);
    const lng = Number(row[lngIndex]);
    const lat = Number(row[latIndex]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      invalid += 1;
      continue;
    }
    const properties = {};
    header.forEach((key, index) => {
      if (index !== lngIndex && index !== latIndex && key) properties[key] = row[index];
    });
    features.push({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lng, lat] } });
  }
  if (!features.length) throw new Error("CSV 没有有效坐标行");
  return { geojson: { type: "FeatureCollection", features }, count: features.length, invalid, name };
}
