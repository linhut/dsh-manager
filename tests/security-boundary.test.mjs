/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * Webview 安全边界回归测试（对应 DSH 0.2.x「跨端物理隔离」）
 * 只断言可观察行为：放行/拒绝的判定结果、加固后的假值、权限回调的实际返回值。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBVIEW_PARTITION,
  isAllowedWebviewSrc,
  isSafeExternalUrl,
  sanitizeWebviewPreferences,
  guardWebviewAttach,
  installSessionGuards,
} from '../electron/host/security.js';

describe('webview src 白名单', () => {
  it('放行本机 DSH 页面（含端口与查询串）', () => {
    assert.equal(isAllowedWebviewSrc('http://127.0.0.1:3080/'), true);
    assert.equal(isAllowedWebviewSrc('http://127.0.0.1:3080/?token=abc123'), true);
    assert.equal(isAllowedWebviewSrc('http://localhost:3080/chat'), true);
    assert.equal(isAllowedWebviewSrc('http://[::1]:3080/'), true);
  });

  it('拒绝远程主机与协议伪装', () => {
    assert.equal(isAllowedWebviewSrc('https://evil.com/'), false);
    assert.equal(isAllowedWebviewSrc('http://127.0.0.1.evil.com/'), false);
    assert.equal(isAllowedWebviewSrc('http://localhost.evil.com/'), false);
    assert.equal(isAllowedWebviewSrc('file:///C:/Windows/System32/calc.exe'), false);
    assert.equal(isAllowedWebviewSrc('javascript:alert(1)'), false);
    assert.equal(isAllowedWebviewSrc('data:text/html,<script>alert(1)</script>'), false);
  });

  it('拒绝空值与非法输入', () => {
    assert.equal(isAllowedWebviewSrc(''), false);
    assert.equal(isAllowedWebviewSrc('   '), false);
    assert.equal(isAllowedWebviewSrc(null), false);
    assert.equal(isAllowedWebviewSrc(undefined), false);
    assert.equal(isAllowedWebviewSrc({ src: 'http://127.0.0.1' }), false);
    assert.equal(isAllowedWebviewSrc('not a url'), false);
  });
});

describe('外部跳转协议白名单', () => {
  it('只放行 http / https / mailto', () => {
    assert.equal(isSafeExternalUrl('https://github.com/linhut/dsh-manager'), true);
    assert.equal(isSafeExternalUrl('http://127.0.0.1:3080'), true);
    assert.equal(isSafeExternalUrl('mailto:a@b.com'), true);
    assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('smb://host/share'), false);
  });
});

describe('webPreferences 加固', () => {
  it('剥离 preload 并强制关闭 Node 集成', () => {
    const prefs = {
      preload: 'file:///evil-preload.js',
      preloadURL: 'file:///evil-preload.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      partition: 'persist:attacker',
    };

    sanitizeWebviewPreferences(prefs);

    assert.equal('preload' in prefs, false);
    assert.equal('preloadURL' in prefs, false);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.allowRunningInsecureContent, false);
    assert.equal(prefs.partition, WEBVIEW_PARTITION);
  });

  it('对非对象输入保持幂等，不抛异常', () => {
    assert.equal(sanitizeWebviewPreferences(null), null);
    assert.equal(sanitizeWebviewPreferences(undefined), undefined);
    assert.equal(sanitizeWebviewPreferences('x'), 'x');
  });
});

describe('will-attach-webview 挂载判定', () => {
  function fakeEvent() {
    return { prevented: false, preventDefault() { this.prevented = true; } };
  }

  it('非法 src 直接阻止挂载，且不改动 prefs', () => {
    const event = fakeEvent();
    const prefs = { preload: 'file:///evil.js', nodeIntegration: true };
    const result = guardWebviewAttach(event, prefs, { src: 'https://evil.com/' });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'src-not-allowed');
    assert.equal(event.prevented, true);
    // 被拒的挂载不应产生"已加固"的假象，prefs 保持原样交给 Electron 丢弃
    assert.equal(prefs.nodeIntegration, true);
  });

  it('合法 src 放行并完成加固', () => {
    const event = fakeEvent();
    const prefs = { preload: 'file:///evil.js', nodeIntegration: true, partition: 'persist:attacker' };
    const params = { src: 'http://127.0.0.1:3080/?token=t', preload: 'file:///evil.js' };

    const result = guardWebviewAttach(event, prefs, params);

    assert.equal(result.allowed, true);
    assert.equal(event.prevented, false);
    assert.equal('preload' in prefs, false);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.partition, WEBVIEW_PARTITION);
    assert.equal('preload' in params, false);
    assert.equal(params.partition, WEBVIEW_PARTITION);
    assert.equal(params.src, 'http://127.0.0.1:3080/?token=t');
  });

  it('缺少 params 时按空 src 拒绝，不抛异常', () => {
    const event = fakeEvent();
    const result = guardWebviewAttach(event, {}, undefined);
    assert.equal(result.allowed, false);
    assert.equal(event.prevented, true);
  });
});

describe('session 权限策略', () => {
  function fakeSession() {
    let requestHandler = null;
    let checkHandler = null;
    return {
      setPermissionRequestHandler(fn) { requestHandler = fn; },
      setPermissionCheckHandler(fn) { checkHandler = fn; },
      ask(permission) {
        let granted;
        requestHandler({}, permission, (value) => { granted = value; });
        return granted;
      },
      check(permission) {
        return checkHandler({}, permission);
      },
    };
  }

  it('默认拒绝设备权限，只放行剪贴板写入', () => {
    const s = fakeSession();
    installSessionGuards(s);

    assert.equal(s.ask('media'), false);
    assert.equal(s.ask('geolocation'), false);
    assert.equal(s.ask('notifications'), false);
    assert.equal(s.ask('clipboard-sanitized-write'), true);
  });

  it('同步权限检查与请求结果保持一致', () => {
    const s = fakeSession();
    installSessionGuards(s);

    assert.equal(s.check('media'), false);
    assert.equal(s.check('clipboard-sanitized-write'), true);
  });

  it('零权限策略可完全关闭放行面', () => {
    const s = fakeSession();
    installSessionGuards(s, { allowedPermissions: [] });

    assert.equal(s.ask('media'), false);
    assert.equal(s.ask('clipboard-sanitized-write'), false);
  });

  it('传入空 session 时安全返回，不抛异常', () => {
    assert.deepEqual(installSessionGuards(null), { installed: false });
  });
});
