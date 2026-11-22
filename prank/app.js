/* ==========================================================================
   app.js — 整蛊页面逻辑
   3-1：光标跟随光晕（本节）
   3-2 弹窗管理器 / 3-3 状态机 / 3-4 逐幕内容 后续补充
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   光标跟随光晕
   - 只在有精确指针（鼠标/触控板）的设备上启用，触屏直接跳过
   - 位置带缓动（lerp），颜色随横向位置在蓝→青→紫之间过渡
   - 用 requestAnimationFrame 节流，静止后自动停帧
   -------------------------------------------------------------------------- */
(function initCursorGlow() {
  const glow = document.getElementById('cursor-glow');
  if (!glow) return;

  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (!finePointer.matches) return;

  let targetX = window.innerWidth * 0.5;
  let targetY = window.innerHeight * 0.38;
  let currentX = targetX;
  let currentY = targetY;
  let rafId = 0;

  function paint() {
    // 缓动跟随：越靠近目标速度越慢，形成柔和拖尾感
    currentX += (targetX - currentX) * 0.14;
    currentY += (targetY - currentY) * 0.14;

    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;

    // 横向位置 → 色相 205（蓝）~ 330（紫）；纵向位置 → 亮度微调
    const hue = 205 + (currentX / width) * 125;
    const light = 62 + (1 - currentY / height) * 6;

    glow.style.setProperty('--gx', `${currentX.toFixed(1)}px`);
    glow.style.setProperty('--gy', `${currentY.toFixed(1)}px`);
    glow.style.setProperty('--glow-hue', hue.toFixed(1));
    glow.style.setProperty('--glow-light', `${light.toFixed(1)}%`);

    const settled =
      Math.abs(targetX - currentX) < 0.4 && Math.abs(targetY - currentY) < 0.4;

    rafId = settled ? 0 : requestAnimationFrame(paint);
  }

  function wake() {
    if (!rafId) rafId = requestAnimationFrame(paint);
  }

  window.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return;
      if (!glow.classList.contains('is-on')) glow.classList.add('is-on');

      targetX = event.clientX;
      targetY = event.clientY;
      wake();
    },
    { passive: true }
  );

  // 首次渲染：让光晕在右上区域淡淡出现，页面不至于一开始全暗
  glow.style.setProperty('--gx', `${targetX}px`);
  glow.style.setProperty('--gy', `${targetY}px`);
  glow.classList.add('is-on');
  rafId = requestAnimationFrame(paint);
})();

/* --------------------------------------------------------------------------
   弹窗管理器（阶段 3-2）
   - 统一管理弹窗的创建、层级、同屏上限与关闭动效
   - z-index：从 1000 起，每层 +10；后开的永远在上
   - 同屏最多 3 个：超出时拒绝打开并给出警告
   - 每个弹窗关闭后都会回调 onClose(reason) 供状态机衔接下一幕
   -------------------------------------------------------------------------- */
window.Dialog = (function initDialogManager() {
  const layer = document.getElementById('dialog-layer');
  const backdrop = document.getElementById('backdrop');

  const stack = []; // { id, el, modal, onClose }
  const MAX = 3;
  const Z_BASE = 1000;
  const Z_STEP = 10;

  let seq = 0;
  let closeHook = null; // 统计 / 调试用：任意弹窗关闭后回调

  function topDialog() {
    return stack[stack.length - 1] || null;
  }

  // 同步遮罩与“下层变暗”：只有模态叠模态时才压暗下层
  function syncChrome() {
    backdrop.hidden = !stack.some((d) => d.modal);

    const top = topDialog();
    stack.forEach((d) => {
      const shouldDim = Boolean(top && d !== top && d.modal && top.modal);
      d.el.classList.toggle('is-dimmed', shouldDim);
    });
  }

  function detach(rec, reason) {
    const index = stack.indexOf(rec);
    if (index === -1) return;

    stack.splice(index, 1);
    rec.el.classList.remove('is-dimmed');
    rec.el.classList.add('is-closing');
    syncChrome();

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const why = reason || 'api';
      rec.el.remove();
      if (typeof rec.onClose === 'function') rec.onClose(why);
      if (typeof closeHook === 'function') closeHook(why);
    };

    rec.el.addEventListener('animationend', (event) => {
      if (event.target === rec.el) finish();
    });
    // 兜底：用户开启“减少动态效果”时动画可能不触发
    setTimeout(finish, 260);
  }

  // 生成底部按钮（open 与 update 共用）
  function buildButtons(foot, buttons, id) {
    foot.innerHTML = '';
    const list = buttons && buttons.length ? buttons : [{ label: '关闭', kind: 'ghost' }];

    list.forEach((cfg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn--${cfg.kind || 'ghost'}`;
      btn.textContent = cfg.label;
      if (cfg.disabled) btn.disabled = true;

      let handled = false; // 防连点：一次点击只处理一次
      btn.addEventListener('click', () => {
        if (handled) return;
        handled = true;
        // 先出栈，允许 onClick 里立即打开下一个弹窗
        if (cfg.closeOnClick !== false) close(id, 'button');
        if (typeof cfg.onClick === 'function') cfg.onClick();
      });

      foot.appendChild(btn);
    });
  }

  // 原地更新标题 / 内容 / 按钮（不重建弹窗，用于假进度条等）
  function update(id, patch = {}) {
    const rec = stack.find((d) => d.id === id);
    if (!rec) return false;

    if (typeof patch.title === 'string') {
      rec.el.querySelector('.dialog__title').textContent = patch.title;
    }

    if (patch.body !== undefined) {
      const bodyEl = rec.el.querySelector('.dialog__body');
      bodyEl.innerHTML = '';
      if (patch.body instanceof Node) {
        bodyEl.appendChild(patch.body);
      } else {
        bodyEl.innerHTML = String(patch.body);
      }
    }

    if (Array.isArray(patch.buttons)) {
      buildButtons(rec.el.querySelector('.dialog__foot'), patch.buttons, id);
    }

    return true;
  }

  function close(id, reason) {
    const rec = stack.find((d) => d.id === id);
    if (rec) detach(rec, reason);
    return Boolean(rec);
  }

  function closeTop(reason) {
    const top = topDialog();
    if (top) detach(top, reason);
    return Boolean(top);
  }

  function closeAll(reason) {
    [...stack].forEach((rec) => detach(rec, reason));
  }

  /**
   * 打开一个弹窗。
   * @param {object} options
   * @param {string} [options.id]        唯一 id
   * @param {string} [options.title]     标题
   * @param {string|Node} [options.body] 内容（字符串按 HTML 解析）
   * @param {Array}  [options.buttons]   [{ label, kind, closeOnClick, onClick }]
   * @param {boolean}[options.modal]     是否模态（默认 true）
   * @param {string} [options.className] 额外类名，如 dialog--mini
   * @param {Function}[options.onClose]  关闭后回调，参数为关闭原因
   *
   * 说明：弹窗只能通过底部按钮关闭（点遮罩 / 右上角 × 均不关闭）。
   * @returns {string|null} 弹窗 id；达到上限时返回 null
   */
  function open(options = {}) {
    if (stack.length >= MAX) {
      console.warn(`[Dialog] 同屏最多 ${MAX} 个弹窗，本次打开已忽略`);
      return null;
    }

    const {
      id = `dialog-${++seq}`,
      title = '提示',
      body = '',
      buttons = [],
      modal = true,
      className = '',
      onClose = null,
      offset = null, // 自定义阶梯偏移（像素），默认按层级 14px
    } = options;

    const el = document.createElement('div');
    el.className = [
      'dialog',
      modal ? 'dialog--modal' : 'dialog--floating',
      className,
    ]
      .filter(Boolean)
      .join(' ');
    el.id = id;
    el.setAttribute('role', 'dialog');
    if (modal) el.setAttribute('aria-modal', 'true');
    el.style.zIndex = String(Z_BASE + stack.length * Z_STEP + 10);
    const offsetPx = Number.isFinite(offset) ? offset : stack.length * 14;
    el.style.setProperty('--off', `${offsetPx}px`);

    const titleId = `${id}-title`;
    el.setAttribute('aria-labelledby', titleId);

    // 头部（无图标、无右上角关闭按钮，只能点底部按钮关闭）
    const head = document.createElement('header');
    head.className = 'dialog__head';

    const titleEl = document.createElement('h2');
    titleEl.className = 'dialog__title';
    titleEl.id = titleId;
    titleEl.textContent = title;
    head.appendChild(titleEl);

    // 内容
    const bodyEl = document.createElement('div');
    bodyEl.className = 'dialog__body';
    if (body instanceof Node) {
      bodyEl.appendChild(body);
    } else {
      bodyEl.innerHTML = body;
    }

    el.appendChild(head);
    el.appendChild(bodyEl);

    // 底部按钮：未提供按钮时补一个「关闭」，保证弹窗永远可关闭
    const foot = document.createElement('footer');
    foot.className = 'dialog__foot';
    buildButtons(foot, buttons, id);

    el.appendChild(foot);

    layer.appendChild(el);

    // 入场动画结束后固定住，避免后续增删动效类时重复播放入场
    el.addEventListener('animationend', function onEnterEnd(event) {
      if (event.target === el) {
        el.classList.add('is-settled');
        el.removeEventListener('animationend', onEnterEnd);
      }
    });

    const rec = { id, el, modal, onClose };
    stack.push(rec);
    syncChrome();

    // 焦点给到第一个按钮，键盘用户可直接操作
    requestAnimationFrame(() => {
      const target = el.querySelector('.dialog__foot .btn') || el.querySelector('button');
      if (target) target.focus({ preventScroll: true });
    });

    return id;
  }

  // 点遮罩不关闭弹窗：必须点底部按钮

  return {
    open,
    update,
    close,
    closeTop,
    closeAll,
    setCloseHook(fn) {
      closeHook = fn;
    },
    get count() {
      return stack.length;
    },
    get topId() {
      const top = topDialog();
      return top ? top.id : null;
    },
    MAX,
  };
})();

/* --------------------------------------------------------------------------
   弹窗组件演示（阶段 3-2 自检用）
   访问 index.html?demo 即可打开 3 个示例弹窗，查看层级、偏移、变暗与上限。
   -------------------------------------------------------------------------- */
(function initDialogDemo() {
  if (!new URLSearchParams(window.location.search).has('demo')) return;

  const samples = [
    {
      title: '示例弹窗 1',
      body: '这是可复用弹窗组件：带入场动效、底部按钮，关闭后自动移除。<br><br>点遮罩或按 ESC 都不会关闭，必须点按钮。',
      buttons: [
        { label: '取消', kind: 'ghost' },
        { label: '知道了', kind: 'primary' },
      ],
    },
    {
      title: '示例弹窗 2（叠在上层）',
      body: '第二个弹窗的 z-index 更高，并把下层压暗。同一时间最多 3 个弹窗。',
      buttons: [{ label: '关闭', kind: 'primary' }],
    },
    {
      title: '示例弹窗 3（上限内）',
      body: '第三个弹窗出现时第二个同样变暗。再尝试打开第 4 个会被拒绝并在控制台提示。',
      buttons: [{ label: '好', kind: 'danger' }],
    },
  ];

  samples.forEach((sample, index) => {
    setTimeout(() => Dialog.open(sample), 400 * (index + 1));
  });
})();

/* ==========================================================================
   状态机（阶段 3-3）
   状态：BOOT → ERROR → ERROR_CONFIRM → REPAIR_ASK → SKIP_CONFIRM →
         PERMISSION → PROCESS → REBOOT → REBOOT_FAIL → CLOSE_LOOP →
         GLITCH → REVEAL → END
   本阶段各幕仅放占位文案，用于验证跳转；3-4 再填充正式内容与动效。
   ========================================================================== */
const State = Object.freeze({
  BOOT: 'BOOT',
  ERROR: 'ERROR',
  ERROR_CONFIRM: 'ERROR_CONFIRM',
  REPAIR_ASK: 'REPAIR_ASK',
  SKIP_CONFIRM: 'SKIP_CONFIRM',
  PERMISSION: 'PERMISSION',
  PROCESS: 'PROCESS',
  REBOOT: 'REBOOT',
  REBOOT_FAIL: 'REBOOT_FAIL',
  CLOSE_LOOP: 'CLOSE_LOOP',
  GLITCH: 'GLITCH',
  REVEAL: 'REVEAL',
  END: 'END',
});

const game = {
  state: null,
  clicks: 0,
  closedPopups: 0,
  startTime: 0,
  bridgeUsed: false, // “以为关掉了又弹出来”的桥段只出现一次
  escCount: 0,
  lastEscAt: 0,
};

// 调试参数：?fast 让加载 / 倒计时提速 4 倍；?demo 只跑弹窗演示
const URL_PARAMS = new URLSearchParams(window.location.search);
const SPEED = URL_PARAMS.has('fast') ? 4 : 1;

const DURATION = {
  boot: 6000 / SPEED,
  stuck: 3000 / SPEED,
  rebootSeconds: Math.max(3, Math.round(10 / SPEED)),
};

const stageEl = document.getElementById('stage');
const bootScreenEl = document.getElementById('screen-boot');
const surrenderBtn = document.getElementById('surrender');

let screenAbort = new AbortController(); // 每次切换状态时回收旧监听
const timers = new Set();
let bootRaf = 0;
let swarm = null; // 第 7 幕光标群：{ stop, morphToWord }
let glitchWordActive = false; // 第 7 幕是否已进入“光标拼字”阶段（此阶段 ESC×5 直接进终局）

/* ---------- 通用工具 ---------- */

function later(fn, ms) {
  const id = window.setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
  return id;
}

function clearTimers() {
  timers.forEach((id) => window.clearTimeout(id));
  timers.clear();
}

function once(fn) {
  let done = false;
  return (...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
}

function clearStage() {
  stageEl.querySelectorAll('.screen[data-generated]').forEach((el) => el.remove());
  bootScreenEl.classList.remove('is-active');
}

function makeScreen(html) {
  const el = document.createElement('section');
  el.className = 'screen is-active';
  el.dataset.generated = '1';
  el.innerHTML = html;
  stageEl.appendChild(el);
  return el;
}

function resetGame() {
  game.clicks = 0;
  game.closedPopups = 0;
  game.bridgeUsed = false;
  game.escCount = 0;
  game.lastEscAt = 0;
  game.startTime = Date.now();
}

/**
 * 统一状态切换：清理计时器 / 监听 / 弹窗，再渲染目标状态。
 */
function go(next) {
  if (!Object.values(State).includes(next)) {
    console.warn(`[State] 未知状态：${next}`);
    return;
  }

  clearTimers();
  if (bootRaf) {
    cancelAnimationFrame(bootRaf);
    bootRaf = 0;
  }
  if (swarm) {
    swarm.stop();
    swarm = null;
  }
  glitchWordActive = false;
  document.body.classList.remove('is-cursor-hidden'); // 离开抽风幕时恢复真实光标
  screenAbort.abort();
  screenAbort = new AbortController();

  Dialog.closeAll('state-change');
  clearStage();

  game.state = next;

  const renderers = {
    [State.BOOT]: renderBoot,
    [State.ERROR]: renderError,
    [State.ERROR_CONFIRM]: renderErrorConfirm,
    [State.REPAIR_ASK]: renderRepairAsk,
    [State.SKIP_CONFIRM]: renderSkipConfirm,
    [State.PERMISSION]: renderPermission,
    [State.PROCESS]: renderProcess,
    [State.REBOOT]: renderReboot,
    [State.REBOOT_FAIL]: renderRebootFail,
    [State.CLOSE_LOOP]: renderCloseLoop,
    [State.GLITCH]: renderGlitch,
    [State.REVEAL]: renderReveal,
    [State.END]: renderEnd,
  };

  renderers[next]();
}

/* ---------- 各幕渲染（占位内容） ---------- */

// 第 1 幕：假加载
function renderBoot() {
  bootScreenEl.classList.add('is-active');

  const fill = document.getElementById('boot-fill');
  const pct = document.getElementById('boot-pct');
  fill.style.width = '0%';
  pct.textContent = '0%';
  pct.classList.remove('is-stuck');

  const advance = once(() => go(State.ERROR));
  let startTs = 0;

  const tick = (ts) => {
    if (!startTs) startTs = ts;
    const t = Math.min((ts - startTs) / DURATION.boot, 1);
    const eased = 1 - Math.pow(1 - t, 3); // 先快后慢，最后卡在 99%
    const value = Math.round(99 * eased);
    fill.style.width = `${value}%`;
    pct.textContent = `${value}%`;

    if (t < 1) {
      bootRaf = requestAnimationFrame(tick);
    } else {
      bootRaf = 0;
      pct.classList.add('is-stuck');
      later(advance, DURATION.stuck);
    }
  };

  bootRaf = requestAnimationFrame(tick);

  // 点击进度条可以提前推进
  bootScreenEl
    .querySelector('.boot__bar')
    .addEventListener('click', advance, { signal: screenAbort.signal });
}

// 第 2 幕：假报错
function renderError() {
  Dialog.open({
    title: '加载失败',
    body: '<p>资源加载失败（错误码 0x8007）。</p><p>网络似乎不太稳定。</p>',
    buttons: [
      { label: '再试一次', kind: 'primary', onClick: () => go(State.REPAIR_ASK) },
      { label: '算了', kind: 'ghost', onClick: () => go(State.ERROR_CONFIRM) },
    ],
  });
}

// 第 2 幕陷阱：两个按钮都继续
function renderErrorConfirm() {
  Dialog.open({
    title: '确定放弃修复？',
    body: '<p>放弃修复后，当前体验可能无法继续加载。</p>',
    buttons: [
      { label: '放弃修复', kind: 'danger', onClick: () => go(State.REPAIR_ASK) },
      { label: '继续修复', kind: 'primary', onClick: () => go(State.REPAIR_ASK) },
    ],
  });
}

// 第 3 幕：假修复进度 → 停在随机值（>50%）→ 询问
function renderRepairAsk() {
  // 每局随机停在 51%~99%
  const stallAt = 51 + Math.floor(Math.random() * 49);

  const id = Dialog.open({
    title: '正在尝试修复…',
    body:
      '<p>正在扫描异常项…</p>' +
      '<div class="mini-progress"><div class="mini-progress__fill" data-fill></div></div>' +
      '<p class="muted" data-status>0%</p>',
    buttons: [{ label: '请稍候', kind: 'ghost', disabled: true, closeOnClick: false }],
  });
  if (!id) return;

  const el = document.getElementById(id);
  const fill = el.querySelector('[data-fill]');
  const status = el.querySelector('[data-status]');

  // 进度条缓动到随机停滞点
  requestAnimationFrame(() => {
    fill.style.width = `${stallAt}%`;
  });

  const showQuestion = () => {
    if (!document.getElementById(id)) return;

    el.classList.add('is-shaking'); // 窗口抖动两下
    later(() => {
      if (!document.getElementById(id)) return;
      el.classList.remove('is-shaking');

      // 原地变成询问，避免闪现第二个窗口
      Dialog.update(id, {
        title: '检测到 3 个异常项',
        body: `<p>进度停在 ${stallAt}%，检测到 3 个异常项，是否自动修复？</p>`,
        buttons: [
          { label: '一键修复', kind: 'primary', onClick: () => go(State.PERMISSION) },
          { label: '先不修', kind: 'ghost', onClick: () => go(State.SKIP_CONFIRM) },
        ],
      });
    }, 520);
  };

  let pct = 0;
  const step = () => {
    pct = Math.min(stallAt, pct + 2 + Math.floor(Math.random() * 5));
    status.textContent = `${pct}%`;
    if (pct < stallAt) {
      later(step, 60);
    } else {
      later(showQuestion, 550);
    }
  };
  later(step, 120);
}

function renderSkipConfirm() {
  Dialog.open({
    title: '确定跳过修复？',
    body: '<p>异常项将影响后续体验，确定跳过吗？</p>',
    buttons: [
      { label: '确定跳过', kind: 'danger', onClick: () => go(State.PERMISSION) },
      { label: '回去修复', kind: 'primary', onClick: () => go(State.REPAIR_ASK) },
    ],
  });
}

// 第 4 幕：假权限（不会调用真实权限 API）
function renderPermission() {
  Dialog.open({
    title: '权限申请',
    body:
      '<p>本体验需要「网络体验优化」权限。</p>' +
      '<label class="fake-perm">' +
      '<input type="checkbox" checked disabled />' +
      '<span>允许优化网络设置</span>' +
      '</label>' +
      '<p class="muted">检测到 1 项设置可被优化，取消勾选不可用。</p>',
    buttons: [
      { label: '允许', kind: 'primary', onClick: () => go(State.PROCESS) },
      { label: '拒绝', kind: 'ghost', onClick: () => go(State.PROCESS) },
    ],
  });
}

// 第 5 幕：后台进程（同时两个，逐个结束，剩余数实时更新）
function renderProcess() {
  let remaining = 2;
  const ids = [];

  const endOne = () => {
    remaining -= 1;
    if (remaining <= 0) {
      go(State.REBOOT);
      return;
    }
    // 更新还开着的那个窗口的剩余数
    ids.forEach((id) => {
      if (document.getElementById(id)) {
        Dialog.update(id, {
          body: `<p>异常进程仍在占用资源。</p><p class="muted">剩余 ${remaining} 个进程</p>`,
        });
      }
    });
  };

  const makeBody = () =>
    `<p>异常进程正在占用资源。</p><p class="muted">剩余 ${remaining} 个进程</p>`;

  ids.push(
    Dialog.open({
      title: '后台进程 A',
      body: makeBody(),
      className: 'dialog--mini dialog--proc dialog--proc-a',
      modal: false,
      offset: 0,
      buttons: [{ label: '结束进程', kind: 'ghost', onClick: endOne }],
    })
  );

  ids.push(
    Dialog.open({
      title: '后台进程 B',
      body: makeBody(),
      className: 'dialog--mini dialog--proc dialog--proc-b',
      modal: false,
      offset: 76,
      buttons: [{ label: '结束进程', kind: 'ghost', onClick: endOne }],
    })
  );
}

// 第 6 幕：假重启倒计时 + 轻微震动 + 黑屏 3~5 秒
function renderReboot() {
  let left = DURATION.rebootSeconds;

  const el = makeScreen(`
    <p class="sys-line">清理完成</p>
    <h1 class="sys-title">正在重启体验进程…</h1>
    <p class="countdown" data-countdown>${left}</p>
  `);
  el.classList.add('is-shaking');

  const countEl = el.querySelector('[data-countdown]');

  const finish = () => {
    el.classList.remove('is-shaking'); // 黑屏时停止震动，避免边缘露出

    const black = document.createElement('div');
    black.className = 'blackout';
    el.appendChild(black);
    // 先画一帧透明，再过渡到全黑
    requestAnimationFrame(() => black.classList.add('is-visible'));

    // 保持黑屏 3~5 秒再弹出重启失败
    const holdMs = 3000 + Math.round(Math.random() * 2000);
    later(() => go(State.REBOOT_FAIL), holdMs);
  };

  const tick = () => {
    left -= 1;
    if (left <= 0) {
      finish();
      return;
    }
    countEl.textContent = String(left);
    later(tick, 1000);
  };

  later(tick, 1000);
}

// 第 6 幕：重启失败 + 一次性“关不掉”桥段
function renderRebootFail() {
  Dialog.open({
    title: '错误',
    body: '<p>进程重启失败（错误码 0x8007）。</p>',
    buttons: [
      {
        label: '关闭',
        kind: 'ghost',
        onClick: () => {
          if (!game.bridgeUsed) {
            game.bridgeUsed = true;
            go(State.CLOSE_LOOP);
          } else {
            go(State.REBOOT_FAIL);
          }
        },
      },
      { label: '结束进程', kind: 'primary', onClick: () => go(State.GLITCH) },
    ],
  });
}

// 第 6 幕陷阱：两层“你确定吗”（整局仅触发一次）
function renderCloseLoop() {
  const openSecond = () => {
    Dialog.open({
      title: '确定不关闭吗？',
      body: '<p>这是最后一次确认。</p>',
      buttons: [
        { label: '确定关闭', kind: 'danger', onClick: () => go(State.REBOOT_FAIL) },
        { label: '再想想', kind: 'ghost', onClick: () => go(State.REBOOT_FAIL) },
      ],
    });
  };

  Dialog.open({
    title: '你真的要关闭吗？',
    body: '<p>关闭后，当前体验进度将无法恢复。</p>',
    buttons: [
      // closeOnClick: false → 第一层保留在下面，形成套娃
      { label: '关闭', kind: 'ghost', closeOnClick: false, onClick: openSecond },
      { label: '取消', kind: 'ghost', onClick: () => go(State.REBOOT_FAIL) },
    ],
  });
}

// 第 7 幕：满屏 Windows 系统报错 + 大量随机光标
const WIN_ERROR_SAMPLES = [
  {
    title: 'Microsoft Visual Basic for Applications',
    message: '系统错误 &H80004005 (-2147467259)。 未指定的错误',
  },
  {
    title: 'Microsoft Visual Basic for Applications',
    message: '系统错误 &H80070005 (-2147024891)。 拒绝访问',
  },
  {
    title: 'Windows Script Host',
    message: '运行时错误 429：ActiveX 部件不能创建对象',
  },
  {
    title: '应用程序错误',
    message: '0x00000000 指令引用的 0x00000000 内存。该内存不能为 written',
  },
  {
    title: '系统错误',
    message: '系统错误 &H80004015 (-2147467243)。 类未注册',
  },
  {
    title: 'Microsoft Visual Basic for Applications',
    message: '系统错误 &H80004002 (-2147467262)。 不支持此接口',
  },
  {
    title: 'Windows 脚本宿主',
    message: '脚本错误：document 未定义',
  },
  {
    title: '应用程序错误',
    message: '0xc0000005 内存访问冲突',
  },
  {
    title: '系统错误',
    message: '&H8007007E (-2147024770)。 找不到指定的模块',
  },
  {
    title: 'Microsoft Visual Basic for Applications',
    message: '编译错误：未找到方法或数据成员',
  },
  {
    title: '系统错误',
    message: '系统错误 &H80004003 (-2147467261)。 无效的指针',
  },
  {
    title: 'Windows Script Host',
    message: '运行时错误 438：对象不支持该属性或方法',
  },
];

// 生成一个仿 Windows 系统报错面板
function createWinErrorPanel(sample, index) {
  const panel = document.createElement('div');
  panel.className = 'win-error';
  panel.style.setProperty('--tilt', `${(Math.random() * 2.4 - 1.2).toFixed(2)}deg`);
  panel.style.animationDelay = `${Math.min(index, 10) * 20}ms`;

  panel.innerHTML = `
    <div class="win-error__titlebar">
      <span>${sample.title}</span>
      <span class="win-error__close" aria-hidden="true">×</span>
    </div>
    <div class="win-error__body">
      <span class="win-error__icon" aria-hidden="true"></span>
      <p>${sample.message}</p>
    </div>
    <div class="win-error__foot">
      <button class="win-btn win-btn--primary" type="button" tabindex="-1">确定</button>
      <button class="win-btn" type="button" tabindex="-1">帮助</button>
    </div>
  `;

  return panel;
}

/* 光标拼字用的点阵字体：桌面 5×7，手机 3×5 */
const WORD_FONT_WIDE = {
  s: ['11111', '10000', '10000', '11110', '00001', '00001', '11111'],
  i: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  l: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

const WORD_FONT_COMPACT = {
  s: ['111', '100', '111', '001', '111'],
  i: ['111', '010', '010', '010', '111'],
  l: ['100', '100', '100', '100', '111'],
  y: ['101', '101', '010', '010', '010'],
};

// 把单词展开成屏幕坐标点（每个点放一个光标）
function buildWordTargets(word, compact) {
  const font = compact ? WORD_FONT_COMPACT : WORD_FONT_WIDE;
  const dots = [];
  let colOffset = 0;

  for (const ch of word) {
    const glyph = font[ch];
    if (!glyph) continue;

    const glyphCols = glyph[0].length;
    glyph.forEach((row, r) => {
      for (let c = 0; c < glyphCols; c += 1) {
        if (row[c] === '1') dots.push({ col: colOffset + c, row: r });
      }
    });

    colOffset += glyphCols + 1; // 字母之间留一列间距
  }

  const cols = colOffset - 1;
  const rows = compact ? 5 : 7;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const cell = Math.min(
    (vw * (compact ? 0.88 : 0.72)) / cols,
    (vh * (compact ? 0.22 : 0.34)) / rows,
    34
  );

  const wordW = (cols - 1) * cell;
  const wordH = (rows - 1) * cell;
  const originX = (vw - wordW) / 2;
  const originY = (vh - wordH) / 2;

  return dots.map(({ col, row }) => ({
    x: originX + col * cell,
    y: originY + row * cell,
  }));
}

// 大量光标在屏幕内随机漂移、撞边反弹；之后可降速并拼成单词
function startCursorSwarm(container, count) {
  const cursors = [];
  let rafId = 0;

  function createCursor() {
    const el = document.createElement('div');
    el.className = 'fake-cursor';

    const scale = 0.75 + Math.random() * 0.7;
    const w = Math.round(16 * scale);
    const h = Math.round(22 * scale);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;

    const x = Math.random() * window.innerWidth;
    const y = Math.random() * window.innerHeight;
    const rot = Math.random() * 30 - 15;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${rot.toFixed(1)}deg)`;
    container.appendChild(el);

    let vx = (Math.random() - 0.5) * 5;
    let vy = (Math.random() - 0.5) * 5;
    if (Math.abs(vx) < 0.8) vx = vx < 0 ? -0.8 : 0.8;
    if (Math.abs(vy) < 0.8) vy = vy < 0 ? -0.8 : 0.8;

    const rec = { el, x, y, vx, vy, rot, w, h };
    cursors.push(rec);
    return rec;
  }

  for (let i = 0; i < count; i += 1) createCursor();

  const tick = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const c of cursors) {
      c.x += c.vx;
      c.y += c.vy;

      if (c.x < 0) {
        c.x = 0;
        c.vx = Math.abs(c.vx);
      } else if (c.x > w) {
        c.x = w;
        c.vx = -Math.abs(c.vx);
      }

      if (c.y < 0) {
        c.y = 0;
        c.vy = Math.abs(c.vy);
      } else if (c.y > h) {
        c.y = h;
        c.vy = -Math.abs(c.vy);
      }

      c.el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) rotate(${c.rot.toFixed(1)}deg)`;
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // 停在原地，所有光标平移到单词点阵的对应位置
  function morphToWord(word, compact) {
    stop();

    const targets = buildWordTargets(word, compact);
    while (cursors.length < targets.length) createCursor(); // 光标不够就补

    // 强制一次布局，让新补的光标也能从出生点开始过渡
    void container.offsetWidth;

    const formW = 14;
    const formH = 19;

    cursors.forEach((c, index) => {
      // 逐个出发：越靠后的光标越晚移动，形成一点一点拼出来的效果
      c.el.style.transition =
        'transform 1.4s cubic-bezier(0.22, 0.8, 0.2, 1), width 0.5s ease, height 0.5s ease, opacity 0.4s ease';
      c.el.style.transitionDelay = `${250 + Math.min(index * 35, 2200)}ms`;

      if (index < targets.length) {
        const t = targets[index];
        c.w = formW;
        c.h = formH;
        c.el.style.width = `${formW}px`;
        c.el.style.height = `${formH}px`;
        c.x = t.x;
        c.y = t.y;
        c.el.style.transform = `translate3d(${(t.x - formW / 2).toFixed(1)}px, ${(t.y - formH / 2).toFixed(1)}px, 0) rotate(0deg)`;
      } else {
        c.el.style.opacity = '0'; // 多余的光标淡出
      }
    });
  }

  return { stop, morphToWord };
}

function renderGlitch() {
  document.body.classList.add('is-cursor-hidden'); // 隐藏真实光标

  const el = makeScreen('<div class="error-wall" data-wall aria-hidden="true"></div>');
  const wall = el.querySelector('[data-wall]');
  const isNarrow = window.innerWidth < 700;

  // 多个“窗口堆”，每堆 2 个错位叠放，铺满整屏但不排整齐
  const anchors = isNarrow
    ? [
        [4, 6],
        [6, 50],
      ]
    : [
        [2, 3],
        [26, 5],
        [50, 2],
        [74, 4],
        [4, 36],
        [28, 38],
        [52, 35],
        [76, 37],
        [2, 69],
        [26, 71],
        [50, 68],
        [74, 70],
      ];
  const perCluster = isNarrow ? 3 : 2;

  let panelIndex = 0;
  anchors.forEach((anchor, clusterIndex) => {
    for (let i = 0; i < perCluster; i += 1) {
      const sample = WIN_ERROR_SAMPLES[panelIndex % WIN_ERROR_SAMPLES.length];
      const panel = createWinErrorPanel(sample, panelIndex);

      // 基准位置加大随机抖动，避免每次/每堆都整齐对齐
      const left = anchor[0] + (Math.random() * 8 - 4);
      const top = anchor[1] + (Math.random() * 10 - 5);
      panel.style.left = `${left.toFixed(1)}%`;
      panel.style.top = `${top.toFixed(1)}%`;
      panel.style.marginLeft = `${i * 24 + Math.random() * 10}px`; // 堆叠偏移量
      panel.style.marginTop = `${i * 30 + Math.random() * 12}px`;
      panel.style.zIndex = String(clusterIndex * 10 + i + 1);

      wall.appendChild(panel);
      panelIndex += 1;
    }
  });

  // 很多很多光标：手机少一些，桌面铺满
  swarm = startCursorSwarm(el, isNarrow ? 12 : 28);

  // 只保留 Enter：报错墙淡出，光标一点点聚拢拼出 silly
  // 拼完后不自动跳转，等用户自己按 ESC 5 次进入终局
  let arranged = false;

  const showWord = () => {
    if (arranged) return;
    arranged = true;
    glitchWordActive = true;

    wall.classList.add('is-clearing');
    if (swarm) swarm.morphToWord('silly', isNarrow);
  };

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return;
      if (Dialog.count > 0) return; // 退出弹窗打开时交给弹窗自己处理
      event.preventDefault();
      showWord();
    },
    { signal: screenAbort.signal }
  );
}

// 第 8 幕：终局选择（只保留两个大按钮）
function renderReveal() {
  const el = makeScreen(`
    <div class="final">
      <button class="btn btn--big btn--ghost" type="button" data-retry>再试一次</button>
      <button class="btn btn--big btn--primary" type="button" data-quit>游戏失败</button>
    </div>
  `);

  // 再试一次：重置统计并重新开始（防连点）
  el
    .querySelector('[data-retry]')
    .addEventListener(
      'click',
      once(() => {
        resetGame();
        go(State.BOOT);
      }),
      { signal: screenAbort.signal }
    );

  // 游戏失败：最后一次“吓一下”（防连点）
  el
    .querySelector('[data-quit]')
    .addEventListener('click', once(openFakeWindowsError), { signal: screenAbort.signal });
}

// 经典 Windows 系统报错风格弹窗（纯网页模拟，不接触真实系统）
const WIN_ERROR_DIALOG_ID = 'win-error-dialog';

function openFakeWindowsError() {
  if (document.getElementById(WIN_ERROR_DIALOG_ID)) return; // 防重复弹出

  Dialog.open({
    id: WIN_ERROR_DIALOG_ID,
    title: 'Windows 资源保护',
    className: 'dialog--win',
    body:
      '<p>Windows 资源保护检测到文件损坏。</p>' +
      '<p>请重新启动计算机以运行文件完整性检查。</p>',
    buttons: [
      {
        label: '确定',
        kind: 'win',
        onClick: () => {
          // 重新开始，从初始加载界面继续循环
          resetGame();
          go(State.BOOT);
        },
      },
    ],
  });
}

function renderEnd() {
  makeScreen(`
    <div class="reveal">
      <h1 class="reveal__title">已结束</h1>
      <p class="reveal__text">可以安全关闭这个页面了。</p>
    </div>
  `);
}

/* ---------- 全局退出方式 ---------- */

function canLeavePrank() {
  return Boolean(game.state) && game.state !== State.END;
}

// 退出时的告别弹窗（ESC×5 与「我认输」共用）
const GIVE_UP_DIALOG_ID = 'give-up-dialog';

function showGiveUpDialog() {
  if (!canLeavePrank()) return;
  if (document.getElementById(GIVE_UP_DIALOG_ID)) return; // 避免重复弹出

  const id = Dialog.open({
    id: GIVE_UP_DIALOG_ID,
    title: '提示',
    body: '<p>唉~回家吃饭吧你还是</p>',
    buttons: [
      {
        label: '好吧',
        kind: 'ghost',
        onClick: () => go(State.END),
      },
    ],
  });

  // 极端情况：弹窗已满，直接放行
  if (!id) go(State.END);
}

// 「我认输」：弹出告别弹窗
surrenderBtn.addEventListener('click', showGiveUpDialog);

// ESC 连按 5 次：静默触发同一个告别弹窗（界面上没有提示）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !canLeavePrank()) return;

  const now = Date.now();
  if (now - game.lastEscAt > 2000) game.escCount = 0;
  game.lastEscAt = now;
  game.escCount += 1;

  if (game.escCount >= 5) {
    game.escCount = 0;

    // 光标拼字阶段：ESC×5 直接进入「再试一次 / 游戏失败」终局页
    if (game.state === State.GLITCH && glitchWordActive) {
      go(State.REVEAL);
    } else {
      showGiveUpDialog();
    }
  }
});

/* ---------- 统计与启动 ---------- */

// 统计点击次数
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('button')) {
    game.clicks += 1;
  }
});

// 统计被真正关闭的弹窗数（状态切换清理不计入）
Dialog.setCloseHook((reason) => {
  if (reason === 'button') game.closedPopups += 1;
});

function startGame() {
  resetGame();
  go(State.BOOT);
}

// 调试入口
window.__game = game;
window.__go = go;

// ?demo 只跑弹窗演示，不启动整蛊流程
if (!URL_PARAMS.has('demo')) {
  startGame();
}
