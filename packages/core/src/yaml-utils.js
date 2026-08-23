/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * 解析标量值（布尔/数字/null/引号字符串/流式空容器）
 * @private
 */
function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (value === '{}') return {};
  if (value === '[]') return [];
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 在字符串中查找「不在引号内」的第一个冒号下标；找不到返回 -1
 * @private
 */
function findColonOutsideQuotes(str) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) return i;
  }
  return -1;
}

/**
 * 解析行内键值对（引号感知）。
 * YAML 规则：冒号后必须跟空白或行尾才算 key: value；
 * 「Y:/path」这类「冒号后直接跟非空白」仍是普通标量。
 * @returns {{key: string, value: any, hasValue: boolean} | null}
 * @private
 */
function parseInlineKV(content) {
  const colonIdx = findColonOutsideQuotes(content);
  if (colonIdx < 0) return null;
  const after = content[colonIdx + 1];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  const key = content.slice(0, colonIdx).trim();
  if (!key) return null;
  const raw = content.slice(colonIdx + 1).trim();
  return {
    key,
    value: raw === '' ? null : parseScalar(raw),
    hasValue: raw !== '',
  };
}

/**
 * 判断一行是否为序列项（「-」或「- xxx」）
 * @private
 */
function isSeqItem(content) {
  return content === '-' || content.startsWith('- ');
}

/**
 * 把（已过滤注释/空行的）行集合构建为缩进树
 * @private
 */
function buildIndentTree(lines) {
  const root = { indent: -1, content: '', children: [] };
  const stack = [root];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const node = { indent, content: trimmed.trim(), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

/**
 * 解释一组子节点：首节点为序列项 → 数组；否则 → 合并后的映射
 * @private
 */
function interpretChildren(nodes) {
  if (!nodes || nodes.length === 0) return {};
  const first = nodes[0];
  if (isSeqItem(first.content)) {
    const arr = [];
    for (const node of nodes) arr.push(interpretNode(node));
    return arr;
  }
  const obj = {};
  for (const node of nodes) {
    const entry = interpretMappingEntry(node);
    Object.assign(obj, entry);
  }
  return obj;
}

/**
 * 解析映射条目节点（key: value / key: + 子块）
 * @private
 */
function interpretMappingEntry(node) {
  const { content, children } = node;
  const kv = parseInlineKV(content);
  if (kv && kv.hasValue) {
    return { [kv.key]: kv.value };
  }
  // 「key:」（无行内值）→ 值来自子块（映射/序列）；无子块时保持空对象（兼容旧行为）
  const key = content.endsWith(':') ? content.slice(0, -1).trim() : content.trim();
  const value = children && children.length ? interpretChildren(children) : {};
  return { [key]: value };
}

/**
 * 解释单个节点（序列项或映射条目）
 * @private
 */
function interpretNode(node) {
  const { content, children } = node;
  if (isSeqItem(content)) {
    const rest = content === '-' ? '' : content.slice(2).trim();
    if (rest === '') {
      // 「-」（纯序列标记）→ 值来自子块
      return children && children.length ? interpretChildren(children) : null;
    }
    const kv = parseInlineKV(rest);
    if (kv) {
      // 对象序列项：「- key: value」→ 对象；后续更深缩进的行合并为对象的其他键
      const obj = {
        [kv.key]: kv.hasValue ? kv.value
          : (children && children.length ? interpretChildren(children) : {}),
      };
      if (kv.hasValue && children && children.length) {
        const sub = interpretChildren(children);
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          Object.assign(obj, sub);
        }
      }
      return obj;
    }
    // 标量序列项（含「- "id: xxx"」这类引号字符串 → 仍是字符串）
    return children && children.length ? interpretChildren(children) : parseScalar(rest);
  }
  return interpretMappingEntry(node);
}

/**
 * 解析 YAML 文本（支持嵌套对象、键值对、对象/标量列表、注释、标量类型）
 * 与 DSH 官方格式兼容：「- id: xxx」解析为 { id: "xxx" } 而非字符串。
 *
 * 已知限制：不处理流式复杂结构、多行字符串、锚点/别名；
 * 序列项紧凑映射（「- key:」后跟同级键）按「子块归属首个键」处理。
 * @param {string} yaml
 * @returns {object}
 */
export function parseYAML(yaml) {
  const lines = String(yaml).split('\n');
  const root = buildIndentTree(lines);
  return interpretChildren(root.children);
}

/**
 * 判断字符串是否需要加引号（含特殊字符 / 空串 / 会被解析为非字符串的纯标量）
 * @private
 */
function needsQuoting(value) {
  if (value === '') return true;
  if (/[:#'\n\r]/.test(value)) return true;
  if (value.trim() !== value) return true;
  const t = value.trim();
  if (t === 'true' || t === 'false' || t === 'null' || t === '~') return true;
  if (t !== '' && !isNaN(Number(t))) return true;
  return false;
}

/**
 * 格式化标量值（字符串含特殊字符时加引号）
 * @private
 */
function formatValue(value) {
  if (typeof value === 'string') {
    if (needsQuoting(value)) return JSON.stringify(value);
    return value;
  }
  return String(value);
}

/**
 * 将对象序列化为 YAML 文本
 * @param {object} obj
 * @param {number} [indent=0]
 * @returns {string}
 */
export function toYAML(obj, indent = 0) {
  const prefix = '  '.repeat(indent);
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;

    if (value === null || value === undefined) {
      result += prefix + key + ': null\n';
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) {
        result += prefix + key + ': {}\n';
      } else {
        result += prefix + key + ':\n';
        result += toYAML(value, indent + 1);
      }
    } else if (Array.isArray(value)) {
      result += prefix + key + ':\n';
      for (const item of value) {
        if (typeof item === 'object') {
          result += prefix + '  - ';
          result += toYAML(item, indent + 2).trimStart();
        } else {
          result += prefix + '  - ' + formatValue(item) + '\n';
        }
      }
    } else {
      result += prefix + key + ': ' + formatValue(value) + '\n';
    }
  }

  return result;
}
