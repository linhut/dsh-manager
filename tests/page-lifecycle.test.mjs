/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * 页面生命周期契约回归测试
 *
 * 渲染层尚未 ESM 化（P1-3b），page-manager.js 仍是传统 <script> 脚本，
 * 因此这里用 new Function 加载**真实源码**执行，而不是复制一份逻辑到测试里。
 * 依赖（window / document / 定时器 / console）全部由测试注入，被测代码零改动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(
  new URL('../src/assets/js/modules/page-manager.js', import.meta.url),
  'utf8',
);

/** 极简元素桩：只提供被测代码实际用到的 classList 与 dataset */
function makeElement(dataset = {}) {
  const classes = new Set();
  return {
    dataset,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

/** 构造 document 桩：页面容器 id 形如 page-xxx，内容容器 id 形如 xxxContent */
function makeDocument(pageIds) {
  const navItems = pageIds.map((id) => makeElement({ page: id }));
  const pageDivs = new Map(pageIds.map((id) => ['page-' + id, makeElement()]));
  const contents = new Map(pageIds.map((id) => [id + 'Content', makeElement()]));

  return {
    navItems,
    pageDivs,
    contents,
    document: {
      querySelectorAll(selector) {
        if (selector === '.nav-item') return navItems;
        if (selector === '.page') return Array.from(pageDivs.values());
        return [];
      },
      querySelector(selector) {
        const m = /^\.nav-item\[data-page="(.+)"\]$/.exec(selector);
        if (!m) return null;
        return navItems.find((el) => el.dataset.page === m[1]) || null;
      },
      getElementById(id) {
        return pageDivs.get(id) || contents.get(id) || null;
      },
    },
  };
}

function createHarness(pageIds = ['alpha', 'beta']) {
  const dom = makeDocument(pageIds);
  const log = { loading: [], errors: [], consoleErrors: [] };
  const timers = { intervals: [], timeouts: [], clearedIntervals: [], clearedTimeouts: [] };

  const factory = new Function(
    'window', 'document', 'showLoading', 'showError',
    'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'console',
    SOURCE + '\nreturn PageManager;',
  );

  const PageManager = factory(
    {}, // window：不挂 appState，走最小路径
    dom.document,
    (_el, msg) => log.loading.push(msg),
    (_el, msg) => log.errors.push(msg),
    (fn, ms) => { const t = { fn, ms }; timers.intervals.push(t); return t; },
    (fn, ms) => { const t = { fn, ms }; timers.timeouts.push(t); return t; },
    (t) => timers.clearedIntervals.push(t),
    (t) => timers.clearedTimeouts.push(t),
    { error: (...a) => log.consoleErrors.push(a), warn: (...a) => log.consoleErrors.push(a) },
  );

  return { PageManager, manager: new PageManager(), dom, log, timers };
}

describe('页面契约校验', () => {
  it('id 非法或页面不是对象时拒绝注册', () => {
    const { manager } = createHarness();
    assert.throws(() => manager.register('', { render() {} }), TypeError);
    assert.throws(() => manager.register('x', null), TypeError);
    assert.throws(() => manager.register('x', 'render'), TypeError);
  });

  it('生命周期钩子必须是函数', () => {
    const { manager } = createHarness();
    assert.throws(() => manager.register('x', { render: 'not-a-fn' }), TypeError);
    assert.throws(() => manager.register('x', { unmount: 1 }), TypeError);
  });

  it('只给 render 也能注册（兼容旧写法）', () => {
    const { manager } = createHarness();
    assert.doesNotThrow(() => manager.register('alpha', { render() {} }));
  });
});

describe('首次进入', () => {
  it('调用 render 并传入 params 与 ctx', async () => {
    const { manager } = createHarness();
    let seen = null;
    manager.register('alpha', { render: (params, ctx) => { seen = { params, ctxId: ctx.id }; } });

    await manager.navigate('alpha', { tab: 'x' });

    assert.deepEqual(seen.params, { tab: 'x' });
    assert.equal(seen.ctxId, 'alpha');
    assert.equal(manager.getCurrentPage(), 'alpha');
    assert.equal(manager.isLoaded('alpha'), true);
  });

  it('首次进入显示 loading，render 失败转为错误提示', async () => {
    const { manager, log } = createHarness();
    manager.register('alpha', { render: () => { throw new Error('boom'); } });

    await manager.navigate('alpha');

    assert.deepEqual(log.loading, ['正在加载...']);
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /boom/);
  });

  it('mount 只在首次进入时执行一次', async () => {
    const { manager } = createHarness();
    let mounts = 0;
    manager.register('alpha', { render() {}, mount: () => { mounts++; } });

    await manager.navigate('alpha');
    await manager.navigate('beta').catch(() => {});
    manager.register('beta', { render() {} });
    await manager.navigate('beta');
    await manager.navigate('beta');

    assert.equal(mounts, 1);
  });

  it('未注册的页面不抛错，只告警', async () => {
    const { manager } = createHarness();
    await assert.doesNotReject(() => manager.navigate('ghost'));
    assert.equal(manager.getCurrentPage(), null);
  });
});

describe('切换页面时的资源回收', () => {
  it('离开页面先 unmount，再释放登记的资源', async () => {
    const { manager } = createHarness();
    const order = [];
    manager.register('alpha', {
      render: (_p, ctx) => { ctx.disposer(() => order.push('dispose')); },
      unmount: () => { order.push('unmount'); },
    });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    await manager.navigate('beta');

    assert.deepEqual(order, ['unmount', 'dispose']);
    assert.equal(manager.getPreviousPage(), 'alpha');
    assert.equal(manager.pendingDisposers('alpha'), 0);
  });

  it('多个资源逆序释放', async () => {
    const { manager } = createHarness();
    const released = [];
    manager.register('alpha', {
      render: (_p, ctx) => {
        ctx.disposer(() => released.push('a'));
        ctx.disposer(() => released.push('b'));
        ctx.disposer(() => released.push('c'));
      },
    });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    await manager.navigate('beta');

    assert.deepEqual(released, ['c', 'b', 'a']);
  });

  it('重复进入同一页不回收自己的资源', async () => {
    const { manager } = createHarness();
    let released = 0;
    let unmounts = 0;
    manager.register('alpha', {
      render: (_p, ctx) => { ctx.disposer(() => { released++; }); },
      unmount: () => { unmounts++; },
    });

    await manager.navigate('alpha');
    await manager.navigate('alpha');

    assert.equal(released, 0);
    assert.equal(unmounts, 0);
  });

  it('单个清理函数抛错不阻断其余回收', async () => {
    const { manager, log } = createHarness();
    const released = [];
    manager.register('alpha', {
      render: (_p, ctx) => {
        ctx.disposer(() => released.push('a'));
        ctx.disposer(() => { throw new Error('dispose boom'); });
      },
    });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    await manager.navigate('beta');

    assert.deepEqual(released, ['a']);
    assert.equal(log.consoleErrors.length, 1);
  });

  it('unmount 抛错仍会释放资源并继续切换', async () => {
    const { manager } = createHarness();
    let released = false;
    manager.register('alpha', {
      render: (_p, ctx) => { ctx.disposer(() => { released = true; }); },
      unmount: () => { throw new Error('unmount boom'); },
    });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    await assert.doesNotReject(() => manager.navigate('beta'));

    assert.equal(released, true);
    assert.equal(manager.getCurrentPage(), 'beta');
  });

  it('释放是幂等的', async () => {
    const { manager } = createHarness();
    let count = 0;
    manager.register('alpha', { render: (_p, ctx) => { ctx.disposer(() => { count++; }); } });

    await manager.navigate('alpha');
    assert.deepEqual(manager.disposePage('alpha'), { disposed: 1, failed: 0 });
    assert.deepEqual(manager.disposePage('alpha'), { disposed: 0, failed: 0 });
    assert.equal(count, 1);
  });
});

describe('ctx 托管定时器与事件', () => {
  it('ctx.interval 在离开页面时被清理', async () => {
    const { manager, timers } = createHarness();
    manager.register('alpha', { render: (_p, ctx) => { ctx.interval(() => {}, 5000); } });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 5000);

    await manager.navigate('beta');
    assert.equal(timers.clearedIntervals.length, 1);
    assert.equal(timers.clearedIntervals[0], timers.intervals[0]);
  });

  it('ctx.timeout 在离开页面时被清理', async () => {
    const { manager, timers } = createHarness();
    manager.register('alpha', { render: (_p, ctx) => { ctx.timeout(() => {}, 300); } });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    await manager.navigate('beta');

    assert.equal(timers.clearedTimeouts.length, 1);
  });

  it('ctx.on 返回解绑并接受非 EventTarget 报错', async () => {
    const { manager } = createHarness();
    let bound = 0;
    let unbound = 0;
    const target = {
      addEventListener: () => { bound++; },
      removeEventListener: () => { unbound++; },
    };
    let ctxRef = null;
    manager.register('alpha', { render: (_p, ctx) => { ctxRef = ctx; ctx.on(target, 'click', () => {}); } });
    manager.register('beta', { render() {} });

    await manager.navigate('alpha');
    assert.equal(bound, 1);
    assert.throws(() => ctxRef.on({}, 'click', () => {}), TypeError);

    await manager.navigate('beta');
    assert.equal(unbound, 1);
  });
});

describe('reload 与 destroy', () => {
  it('reload 先回收再重新渲染', async () => {
    const { manager } = createHarness();
    const events = [];
    manager.register('alpha', {
      render: () => { events.push('render'); },
      unmount: () => { events.push('unmount'); },
    });

    await manager.navigate('alpha');
    await manager.reload('alpha');

    assert.deepEqual(events, ['render', 'unmount', 'render']);
    assert.equal(manager.isLoaded('alpha'), true);
  });

  it('destroy 回收当前页全部资源', async () => {
    const { manager } = createHarness();
    let released = 0;
    manager.register('alpha', { render: (_p, ctx) => { ctx.disposer(() => { released++; }); } });

    await manager.navigate('alpha');
    await manager.destroy();

    assert.equal(released, 1);
    assert.equal(manager.getCurrentPage(), null);
  });
});
