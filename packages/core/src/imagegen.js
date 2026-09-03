/**
 * DSH Manager
 * (c) 2026 Jose AI
 * https://github.com/linhut/dsh-manager
 * MIT License
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DSHConfig } from './config.js';
import { DSHError, DSHErrorCodes } from './errors.js';

/** 生图 API 请求超时（生图模型较慢，给足 240s） */
const IMAGE_GEN_TIMEOUT_MS = 240 * 1000;

/** 默认生图尺寸 */
const DEFAULT_IMAGE_SIZE = '1024x1024';

/**
 * 生图图片保存目录：{用户主目录}/dsh-manager/images
 * 固定目录、与版本无关、用户易找；后续可加设置项。
 */
export function getImageSaveDir() {
  // 测试隔离可用 DSH_MANAGER_IMAGE_DIR 覆盖保存目录
  const overridden = process.env.DSH_MANAGER_IMAGE_DIR;
  if (overridden && String(overridden).trim()) return String(overridden).trim();
  return join(homedir(), 'dsh-manager', 'images');
}

/**
 * 解析 providerKey 对应的 provider 配置（baseURL / apiKeyEnv / models）。
 * 遍历 settings 里所有 llm-<adapter>.providers.<name>。
 * @param {object} settings - read() 返回的 settings
 * @param {string} providerKey - providers 下的键名（如 yang-newapi）
 * @returns {{adapter:string, providerKey:string, baseURL:string, apiKeyEnv:string, models:Array}|null}
 */
export function findProviderConfig(settings, providerKey) {
  if (!settings || !providerKey) return null;
  for (const [adapterKey, adapterCfg] of Object.entries(settings)) {
    if (!/^llm-/.test(adapterKey) || !adapterCfg || typeof adapterCfg !== 'object') continue;
    const providers = adapterCfg.providers || {};
    const conf = providers[providerKey];
    if (conf && typeof conf === 'object') {
      const adapter = adapterKey.replace(/^llm-/, '');
      const models = Array.isArray(conf.models) ? conf.models : [];
      return {
        adapter,
        providerKey,
        baseURL: String(conf.baseURL || conf.baseUrl || '').replace(/\/+$/, ''),
        apiKeyEnv: String(conf.apiKeyEnv || '').replace(/^env:\s*/i, '').trim(),
        models,
      };
    }
  }
  return null;
}

/**
 * 解析真实 API Key：优先 .credentials.yaml 的引用值，其次环境变量。
 * @param {object} credentials - read() 返回的扁平凭据 { refName: value }
 * @param {string} apiKeyEnv - 引用名（无 env: 前缀）
 * @returns {string}
 */
export function resolveApiKey(credentials, apiKeyEnv) {
  if (!apiKeyEnv) return '';
  if (credentials && typeof credentials === 'object') {
    const v = credentials[apiKeyEnv];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  try {
    const env = process.env[apiKeyEnv];
    if (typeof env === 'string' && env.length > 0) return env;
  } catch (e) { /* ignore */ }
  return '';
}

/** 生成时间戳文件名（秒级 + 毫秒，避免同秒覆盖） */
function timestampName() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return (
    '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

/** 根据 b64 data URL / mime 推断扩展名 */
function extFromMime(mime) {
  switch ((mime || '').toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/jpeg': case 'image/jpg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}

/**
 * 核心生图：调 OpenAI 兼容 /images/generations，保存 base64/URL 结果到本地。
 * @param {object} options
 * @param {string} options.providerKey - providers 下的键名
 * @param {string} options.model - 生图模型名（如 dall-e-3 / gpt-image-1 / glm-image）
 * @param {string} options.prompt - 提示词
 * @param {string} [options.size] - 尺寸，默认 1024x1024
 * @param {object} [options.deps] - 测试注入 { config, fetchImpl }
 * @returns {Promise<{path:string, width:number, height:number, size:string, fileName:string, model:string}>}
 */
export async function generateImage(options) {
  const { providerKey, model, prompt, size = DEFAULT_IMAGE_SIZE } = options || {};
  const deps = options && options.deps ? options.deps : {};
  if (!providerKey) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, '请选择 Provider');
  if (!model) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, '请选择生图模型');
  if (!prompt || !String(prompt).trim()) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, '请输入提示词');

  const config = deps.config || new DSHConfig();
  const { settings, credentials } = await config.read();
  const found = findProviderConfig(settings, providerKey);
  if (!found || !found.baseURL) {
    throw new DSHError(DSHErrorCodes.NOT_FOUND, 'Provider 「' + providerKey + '」未配置或缺少 Base URL，请先在 LLM 提供商中配置');
  }
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : resolveApiKey(credentials, found.apiKeyEnv);
  if (!apiKey) {
    throw new DSHError(DSHErrorCodes.NOT_FOUND, 'Provider 「' + found.providerKey + '」未配置 API Key（' + (found.apiKeyEnv || '无引用名') + '），请重新保存该提供商');
  }

  const url = found.baseURL + '/images/generations';
  const body = { model, prompt: String(prompt).trim(), size, response_format: 'b64_json' };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new DSHError(DSHErrorCodes.INTERNAL, '当前环境不支持 fetch');

  let resp;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/abort|timeout/i.test(msg)) {
      throw new DSHError(DSHErrorCodes.TIMEOUT, '生图请求超时（模型较慢，请稍后重试）');
    }
    throw new DSHError(DSHErrorCodes.NETWORK_ERROR, '生图请求失败: ' + msg);
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const t = await resp.text();
      detail = String(t || '').slice(0, 300);
    } catch (e) { /* ignore */ }
    throw new DSHError(DSHErrorCodes.UPSTREAM_ERROR, '生图 API 返回 HTTP ' + resp.status + ' ' + resp.statusText + (detail ? '（' + detail + '）' : '') + '。请确认模型支持 /images/generations 生图。');
  }

  let data;
  try { data = await resp.json(); } catch (e) {
    throw new DSHError(DSHErrorCodes.UPSTREAM_ERROR, '生图 API 响应不是合法 JSON');
  }
  const item = Array.isArray(data && data.data) ? data.data[0] : null;
  if (!item) throw new DSHError(DSHErrorCodes.UNSUPPORTED, '生图 API 未返回图片数据，请确认模型支持 /images/generations');

  let imageBuffer = null;
  let mime = 'image/png';
  if (item.b64_json) {
    const b64 = typeof item.b64_json === 'string' ? item.b64_json : '';
    if (!b64) throw new DSHError(DSHErrorCodes.UNSUPPORTED, '生图 API 返回空的图片数据');
    const dataUrlMatch = /^data:([^;]+);base64,/.exec(b64);
    if (dataUrlMatch) {
      mime = dataUrlMatch[1];
      imageBuffer = Buffer.from(b64.slice(b64.indexOf(',') + 1), 'base64');
    } else {
      imageBuffer = Buffer.from(b64, 'base64');
    }
  } else if (item.url) {
    const urlResp = await fetchImpl(item.url, { signal: AbortSignal.timeout(60000) });
    if (!urlResp.ok) throw new DSHError(DSHErrorCodes.UPSTREAM_ERROR, '下载生图结果失败: HTTP ' + urlResp.status);
    imageBuffer = Buffer.from(await urlResp.arrayBuffer());
    const ct = (urlResp.headers && urlResp.headers.get && urlResp.headers.get('content-type')) || '';
    if (ct) mime = ct;
  } else {
    throw new DSHError(DSHErrorCodes.UNSUPPORTED, '生图 API 响应缺少 b64_json 或 url 字段，请确认模型支持生图');
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    throw new DSHError(DSHErrorCodes.UNSUPPORTED, '生图结果为空');
  }

  const dir = getImageSaveDir();
  try { mkdirSync(dir, { recursive: true }); } catch (e) {
    throw new DSHError(DSHErrorCodes.FS_ERROR, '无法创建图片目录 ' + dir + ': ' + (e && e.message || e));
  }
  const fileName = 'img-' + timestampName() + '.' + extFromMime(mime);
  const filePath = join(dir, fileName);
  try { writeFileSync(filePath, imageBuffer); } catch (e) {
    throw new DSHError(DSHErrorCodes.FS_ERROR, '保存图片失败 ' + filePath + ': ' + (e && e.message || e));
  }

  // 简单读取 PNG 尺寸（可选，失败不阻断）
  let width = 0, height = 0;
  const dim = /^(\d+)x(\d+)$/.exec(size || '');
  if (dim) { width = Number(dim[1]); height = Number(dim[2]); }

  return { path: filePath, fileName, width, height, size: size || DEFAULT_IMAGE_SIZE, model, providerKey: found.providerKey };
}