/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * @dsh-manager/core - 共享 YAML 工具
 * 
 * 统一的 YAML 解析/序列化实现（兼容 dsh settings.yaml 格式）。
 * 供 DSHConfig 与 dsh-utils.readConfigFile 复用，消除重复实现。
 */

/**
 * 解析 YAML 标量
 * @private
 */
function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 将解析出的 _items 占位数组转换为真正的数组
 * @private
 */
function convertItems(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      if (value._items) {
        obj[key] = value._items;
        delete value._items;
      }
      convertItems(value);
    }
  }
}

/**
 * 解析 YAML 文本（支持嵌套对象、键值对、列表、注释、标量类型）
 * @param {string} yaml
 * @returns {object}
 */
export function parseYAML(yaml) {
  const result = {};
  const lines = String(yaml).split('\n');
  const stack = [{ indent: -1, obj: result }];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const content = trimmed.trim();

    // 弹出缩进更大的栈顶
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (content.endsWith(':')) {
      // 对象键
      const key = content.slice(0, -1).trim();
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else if (content.startsWith('- ')) {
      // 列表项（须在键值对判断之前：`- Y:/path` 含冒号但应为列表项字符串）
      const item = content.slice(2).trim();
      if (!Array.isArray(parent._items)) {
        parent._items = [];
      }
      parent._items.push(parseScalar(item));
    } else if (content.includes(':')) {
      // 键值对
      const colonIdx = content.indexOf(':');
      const key = content.slice(0, colonIdx).trim();
      let value = content.slice(colonIdx + 1).trim();

      if (value === '') {
        parent[key] = null;
      } else {
        parent[key] = parseScalar(value);
      }
    }
  }

  convertItems(result);
  return result;
}

/**
 * 格式化标量值（字符串含特殊字符时加引号）
 * @private
 */
function formatValue(value) {
  if (typeof value === 'string') {
    if (value.includes(':') || value.includes('#') || value.includes("'")) {
      return `"${value}"`;
    }
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
      result += `${prefix}${key}: null\n`;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) {
        result += `${prefix}${key}: {}\n`;
      } else {
        result += `${prefix}${key}:\n`;
        result += toYAML(value, indent + 1);
      }
    } else if (Array.isArray(value)) {
      result += `${prefix}${key}:\n`;
      for (const item of value) {
        if (typeof item === 'object') {
          result += `${prefix}  - `;
          result += toYAML(item, indent + 2).trimStart();
        } else {
          result += `${prefix}  - ${formatValue(item)}\n`;
        }
      }
    } else {
      result += `${prefix}${key}: ${formatValue(value)}\n`;
    }
  }

  return result;
}
