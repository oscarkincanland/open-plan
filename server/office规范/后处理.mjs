/**
 * docx 后处理（O-18）：目录域与页码域修正。
 *
 * 这些是生成器库的已知坑（与 ZCode 逆向结论一致）：
 *   - docx-js 生成的 TOC 需要 updateFields，否则打开后目录为空；
 *   - 页码域必须写 `PAGE \* arabic`，写 `decimal` 会在 WPS 显示成 "1decimal"；
 *   - 空 `<w:pgNumType/>` 会让 WPS 困惑。
 *
 * 所有操作幂等，可重复执行。
 */
import fs from "node:fs";
import JSZip from "jszip";

const SETTINGS = "word/settings.xml";
const DOCUMENT = "word/document.xml";

function countOccurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

/** 确保 settings.xml 开启 updateFields。 */
export function ensureUpdateFields(settingsXml) {
  const xml = String(settingsXml || "");
  if (/<w:updateFields\b/.test(xml)) {
    if (/<w:updateFields\b[^>]*w:val="(?:false|0)"/i.test(xml)) {
      return { xml: xml.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>'), changed: true };
    }
    return { xml, changed: false };
  }
  if (/<\/w:settings>/.test(xml)) {
    return { xml: xml.replace(/<\/w:settings>/, '<w:updateFields w:val="true"/></w:settings>'), changed: true };
  }
  return { xml, changed: false };
}

/** 修正页脚/页眉里的 PAGE 域开关。 */
export function fixPageFieldSwitch(xml) {
  const source = String(xml || "");
  const next = source
    .replace(/PAGE\s+\\\*\s+decimal/gi, "PAGE \\* arabic")
    .replace(/PAGE\s+\\\*\s+Arabic/gi, "PAGE \\* arabic");
  return { xml: next, changed: next !== source };
}

/** 清理空 pgNumType，并按需写入 start=1。 */
export function fixPageNumberType(documentXml, { start = 1 } = {}) {
  let xml = String(documentXml || "");
  let changed = false;
  if (/<w:pgNumType\s*\/>/.test(xml)) {
    xml = xml.replace(/<w:pgNumType\s*\/>/g, `<w:pgNumType w:start="${start}"/>`);
    changed = true;
  }
  if (!/<w:pgNumType\b/.test(xml)) {
    // 只改最后一个 sectPr（正文节），避免给封面节也加页码
    const index = xml.lastIndexOf("</w:sectPr>");
    if (index >= 0) {
      xml = `${xml.slice(0, index)}<w:pgNumType w:start="${start}"/>${xml.slice(index)}`;
      changed = true;
    }
  }
  return { xml, changed };
}

/**
 * 对 docx 执行后处理。
 * @param {string} file docx 绝对路径
 * @param {{toc?:boolean,pageNumbers?:boolean,start?:number}} [options]
 * @returns {Promise<{changes:string[]}>}
 */
export async function postProcessDocx(file, { toc = false, pageNumbers = false, start = 1 } = {}) {
  const changes = [];
  const buffer = await fs.promises.readFile(file);
  const zip = await JSZip.loadAsync(buffer);

  if (toc) {
    const entry = zip.file(SETTINGS);
    if (entry) {
      const current = await entry.async("string");
      const result = ensureUpdateFields(current);
      if (result.changed) {
        zip.file(SETTINGS, result.xml);
        changes.push("已开启 updateFields（目录可更新）");
      }
    }
  }

  // 页码域开关：所有 header/footer
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(?:header|footer)\d*\.xml$/.test(name)) continue;
    const entry = zip.file(name);
    if (!entry) continue;
    const current = await entry.async("string");
    const result = fixPageFieldSwitch(current);
    if (result.changed) {
      zip.file(name, result.xml);
      changes.push(`${name} 页码域修正为 arabic`);
    }
  }

  if (pageNumbers) {
    const entry = zip.file(DOCUMENT);
    if (entry) {
      const current = await entry.async("string");
      const result = fixPageNumberType(current, { start });
      if (result.changed) {
        zip.file(DOCUMENT, result.xml);
        changes.push(`已设置正文页码起始为 ${start}`);
      }
    }
  }

  if (changes.length) {
    const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.promises.writeFile(file, output);
  }
  return { changes };
}
