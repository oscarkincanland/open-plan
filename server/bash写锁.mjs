/**
 * bash 写锁范围推导（2026-11-04）
 *
 * 背景：bash 此前对**整个工作区**加写锁，同一工作区并发两个任务时，
 * 一个任务清理自己的 `.work/` 临时文件也会撞上另一个任务正在写的产物，
 * 报「写入范围与其他任务冲突」。这里按常见写命令推导真实目标：
 *   rm/unlink/touch/mkdir/rmdir、mv、cp/install、tee、sed -i、dd of=、重定向。
 * 推导不出目标（如 `bash -c "..."`、构建脚本）时保守回退工作区根目录。
 *
 * 纯逻辑，不依赖 IO，可单测。
 */
import path from "node:path";
import { isInside } from "./workspace.mjs";

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "stat", "file", "pwd", "echo",
  "which", "where", "type", "diff", "sort", "uniq",
]);
const WRITE_COMMANDS = new Set(["rm", "unlink", "touch", "mkdir", "rmdir", "mv", "cp", "install", "tee", "truncate"]);

/** 简单 shell token 化：保留引号内空格，去掉引号。 */
export function splitShellWords(command) {
  const text = String(command || "");
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (!quote) quote = ch;
      else current += ch;
      started = true;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (started) { words.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/** 按 && / || / ; / | 切成命令段（保留重定向 token）。 */
function splitSegments(words) {
  const segments = [];
  let current = [];
  for (const word of words) {
    if (["&&", "||", ";", "|"].includes(word)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(word);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function isOption(token) {
  return String(token || "").startsWith("-");
}

function resolveTarget(raw, cwd, workspace) {
  const text = String(raw || "").trim();
  if (!text || text === "-" || text === "/dev/null" || /^nul$/i.test(text)) return null;
  // 通配符无法逐个枚举：锁住通配符之前的目录，避免 rm -rf .work/* 只锁一个字面量。
  if (/[*?[]/.test(text)) {
    const prefix = text.slice(0, text.search(/[*?[]/));
    const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const base = slash >= 0 ? prefix.slice(0, slash) : ".";
    const directory = path.resolve(cwd, base || ".");
    return isInside(workspace, directory) ? directory : null;
  }
  const target = path.resolve(cwd, text);
  return isInside(workspace, target) ? target : null;
}

/**
 * 推导一条 bash 命令的写目标（绝对路径）。
 * 返回 [] 表示只读/无需加锁；返回 [workspace] 表示无法推导、保守回退。
 */
export function bashWriteTargets(command, { cwd = process.cwd(), workspace = process.cwd() } = {}) {
  const root = path.resolve(workspace);
  let currentCwd = path.resolve(cwd && isInside(root, path.resolve(cwd)) ? cwd : root);
  const targets = new Set();
  let fallback = false;

  const add = (raw) => {
    const target = resolveTarget(raw, currentCwd, root);
    if (target) targets.add(target);
  };

  for (const segment of splitSegments(splitShellWords(command))) {
    if (!segment.length) continue;
    // 处理 cd：后续段按新目录解析（不处理 `cd x && ...` 之外的复杂 shell）
    if (segment[0] === "cd") {
      const next = segment[1] ? path.resolve(currentCwd, segment[1]) : root;
      if (isInside(root, next)) currentCwd = next;
      continue;
    }
    // 重定向：> file、>> file、2> file、&> file
    for (let i = 0; i < segment.length; i += 1) {
      if (/^(?:[12&]?>|>>|&>)$/.test(segment[i]) && segment[i + 1]) add(segment[i + 1]);
    }
    const cmd = String(segment[0] || "").toLowerCase();
    if (cmd === "bash" || cmd === "sh" || cmd === "cmd" || cmd === "powershell" || cmd === "pwsh") {
      // -c 包裹的脚本无法静态推导，保守回退
      if (segment.includes("-c") || segment.includes("/c") || segment.includes("-Command")) fallback = true;
      continue;
    }
    if (!WRITE_COMMANDS.has(cmd) && cmd !== "sed" && cmd !== "perl" && cmd !== "dd") {
      if (cmd && !READ_ONLY_COMMANDS.has(cmd) && !cmd.includes("=")) fallback = true;
      continue;
    }
    const args = segment.slice(1).filter((token) => !isOption(token));
    if (cmd === "cp" || cmd === "install") {
      // 只锁目标（最后一个非选项参数）；源文件只读
      if (args.length >= 2) add(args[args.length - 1]);
      continue;
    }
    if (cmd === "mv") {
      // 源和目标都可能被改（重命名/覆盖）
      args.forEach(add);
      continue;
    }
    if (cmd === "sed" || cmd === "perl") {
      if (segment.includes("-i") || segment.some((token) => /^-i/.test(token))) {
        if (args.length) add(args[args.length - 1]);
      }
      continue;
    }
    if (cmd === "dd") {
      const of = segment.find((token) => /^of=/.test(token));
      if (of) add(of.slice(3));
      else fallback = true;
      continue;
    }
    if (cmd === "tee") {
      args.forEach(add);
      continue;
    }
    // rm / unlink / touch / mkdir / rmdir / truncate
    args.forEach(add);
    if (!args.length) fallback = true;
  }

  if (fallback && !targets.size) targets.add(root);
  return [...targets].sort();
}
