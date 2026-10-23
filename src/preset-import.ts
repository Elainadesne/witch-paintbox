import type { PromptEntry } from './model-settings.js';

export const MAX_PRESET_BYTES = 2 * 1024 * 1024;
export const MAX_PRESET_ENTRIES = 200;

export interface ImportedModelPreset {
  presetName: string;
  head: PromptEntry[];
  tail: PromptEntry[];
  warnings: string[];
}

interface ImportedEntry {
  entry: PromptEntry;
  section?: 'head' | 'tail';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预设包含无效的对象。');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式无效或过长。`);
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_PRESET_ENTRIES) throw new Error('预设列表无效，最多支持 200 条。');
  return value;
}

function parseEntry(value: unknown, index: number, warnings: string[]): ImportedEntry {
  const item = record(value);
  const id = text(item.identifier !== undefined ? item.identifier : item.id !== undefined ? item.id : `entry-${index + 1}`, '条目标识', 128);
  if (!id.trim()) throw new Error('条目标识不能为空。');
  const name = item.name === undefined ? id : text(item.name, '条目名称', 256);
  if (item.marker !== undefined && typeof item.marker !== 'boolean') throw new Error('条目标记格式无效。');
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('条目启用状态格式无效。');
  const marker = item.marker === true;
  const role = item.role === undefined && marker ? 'system' : item.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') throw new Error(`“${name}”的角色不受支持，未导入。`);
  const content = item.content === undefined && marker ? '' : text(item.content, '条目正文', 65_536);
  if (item.section !== undefined && item.section !== 'head' && item.section !== 'tail') throw new Error(`“${name}”的头尾区段无效。`);
  if (marker) warnings.push(`“${name}”是酒馆占位标记，已保留并禁用，不会发送。`);
  if (/\{\{[\s\S]*?\}\}/.test(content)) warnings.push(`“${name}”包含酒馆宏，保留原文，不执行宏。`);
  return {
    entry: { id, name, role, content, enabled: !marker && item.enabled !== false, ...(marker ? { marker: true } : {}) },
    section: item.section,
  };
}

function unique(entries: ImportedEntry[]): void {
  if (entries.length > MAX_PRESET_ENTRIES) throw new Error('预设最多支持 200 条。');
  if (new Set(entries.map(item => item.entry.id)).size !== entries.length) throw new Error('预设包含重复的条目标识，未导入。');
}

function orderEntries(entries: ImportedEntry[], value: unknown, warnings: string[]): ImportedEntry[] {
  if (value === undefined) return entries;
  if (!Array.isArray(value) || value.length > MAX_PRESET_ENTRIES) throw new Error('prompt_order 排序表格式无效。');
  const groups = value.map(raw => {
    const group = record(raw);
    list(group.order);
    return group;
  });
  const group = groups.find(item => item.character_id === 100001) ?? groups[0];
  if (!group) return entries;
  if (groups.length > 1) warnings.push('使用默认角色（100001）排序；没有默认角色时使用第一组排序。');
  const byId = new Map(entries.map(item => [item.entry.id, item]));
  const seen = new Set<string>();
  const ordered = list(group.order).map(raw => {
    const row = record(raw);
    const id = text(row.identifier !== undefined ? row.identifier : row.id, '排序标识', 128);
    if (seen.has(id)) throw new Error('排序表包含重复标识，未导入。');
    const item = byId.get(id);
    if (!item) throw new Error('排序表引用了不存在的条目，未导入。');
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('排序表启用状态格式无效。');
    seen.add(id);
    return { ...item, entry: { ...item.entry, enabled: !item.entry.marker && (row.enabled === undefined ? item.entry.enabled : row.enabled) } };
  });
  for (const item of entries) {
    if (seen.has(item.entry.id)) continue;
    warnings.push(`“${item.entry.name}”不在排序表中，已排在末尾并禁用。`);
    ordered.push({ ...item, entry: { ...item.entry, enabled: false } });
  }
  return ordered;
}

export function importModelPreset(source: string, fallbackName: string): ImportedModelPreset {
  if (source.length > MAX_PRESET_BYTES || new TextEncoder().encode(source).byteLength > MAX_PRESET_BYTES) {
    throw new Error('预设文件不能超过 2 MiB。');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON。'); }
  const raw = record(decoded);
  const warnings: string[] = [];
  const givenName = raw.name !== undefined ? raw.name : raw.presetName;
  const presetName = givenName === undefined ? fallbackName.slice(0, 256) : text(givenName, '预设名称', 256);
  let head: ImportedEntry[];
  let tail: ImportedEntry[];
  if (raw.head !== undefined || raw.tail !== undefined) {
    if (raw.prompts !== undefined || raw.prompt_order !== undefined) throw new Error('预设同时包含两种编排格式，无法确定顺序。');
    head = list(raw.head === undefined ? [] : raw.head).map((item, index) => parseEntry(item, index, warnings));
    tail = list(raw.tail === undefined ? [] : raw.tail).map((item, index) => parseEntry(item, head.length + index, warnings));
    if (head.some(item => item.section === 'tail') || tail.some(item => item.section === 'head')) {
      throw new Error('条目的区段标记与 head/tail 所在位置冲突，未导入。');
    }
    unique([...head, ...tail]);
  } else {
    const entries = list(raw.prompts).map((item, index) => parseEntry(item, index, warnings));
    unique(entries);
    const ordered = orderEntries(entries, raw.prompt_order, warnings);
    const firstTail = ordered.findIndex(item => item.section === 'tail');
    const boundary = firstTail < 0 ? ordered.length : firstTail;
    if (ordered.slice(boundary).some(item => item.section === 'head')) {
      throw new Error('头部与尾部标记交错，无法保持原顺序；请修正区段标记后导入。');
    }
    head = ordered.slice(0, boundary);
    tail = ordered.slice(boundary);
    if (!ordered.some(item => item.section)) warnings.push('预设未声明头尾位置，已保留原顺序；可在左侧移动功能层与最新正文条目。');
  }
  return { presetName, head: head.map(item => item.entry), tail: tail.map(item => item.entry), warnings };
}
