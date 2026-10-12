/* ==========================================================================
   2048 —— 纯前端实现
   渲染：requestAnimationFrame 逐帧驱动，方块位置用 translate3d 合成层动画
   音效：Web Audio API 实时合成，不加载任何音频文件
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  var SIZE = 4;
  var KEY_BEST = 'game2048.best';
  var KEY_MUTED = 'game2048.muted';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SLIDE_MS = reduced ? 0 : 110;
  var SPAWN_MS = reduced ? 0 : 140;
  var SHAKE_MS = 180;

  var DIRS = {
    up:    { dr: -1, dc: 0 },
    down:  { dr: 1,  dc: 0 },
    left:  { dr: 0,  dc: -1 },
    right: { dr: 0,  dc: 1 }
  };

  /* ---------------------------------------------------------------- 工具 */

  function $(sel) { return document.querySelector(sel); }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
  }

  function easeOutBack(p) {
    var c1 = 1.9, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  }

  /* storage 在隐私模式 / 禁用 Cookie 时会抛异常，全部包一层 */
  function loadNum(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      var n = v === null ? NaN : parseInt(v, 10);
      return isFinite(n) && n >= 0 ? n : fallback;
    } catch (e) { return fallback; }
  }

  function saveNum(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 音效引擎 */

  var Sound = {
    ctx: null,
    master: null,
    muted: loadNum(KEY_MUTED, 0) === 1,

    init: function () {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; }
    },

    /* 一个简单的带包络振荡器音符 */
    blip: function (freq, dur, type, gain, delay, slideTo) {
      if (this.muted || !this.ctx) return;
      var t0 = this.ctx.currentTime + (delay || 0);
      var osc = this.ctx.createOscillator();
      var g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    move: function () {
      this.blip(200, 0.06, 'triangle', 0.07, 0);
    },

    /* 合并音高随方块数值上升，越合越"高" */
    merge: function (value) {
      var i = clamp(Math.round(Math.log(value) / Math.LN2) - 1, 0, 12);
      var freq = 300 * Math.pow(1.09, i);
      this.blip(freq, 0.13, 'sine', 0.11, 0);
      this.blip(freq * 2, 0.09, 'sine', 0.045, 0.012);
    },

    blocked: function () {
      this.blip(150, 0.08, 'square', 0.035, 0);
    },

    start: function () {
      var self = this;
      [0, 4, 7].forEach(function (s, i) {
        self.blip(392.0 * Math.pow(2, s / 12), 0.12, 'sine', 0.075, i * 0.055);
      });
    },

    win: function () {
      var self = this;
      [0, 4, 7, 12, 16].forEach(function (s, i) {
        self.blip(392.0 * Math.pow(2, s / 12), 0.22, 'sine', 0.09, i * 0.085);
      });
    },

    over: function () {
      var self = this;
      [0, -3, -7, -12].forEach(function (s, i) {
        self.blip(392.0 * Math.pow(2, s / 12), 0.28, 'triangle', 0.085, i * 0.11);
      });
    },

    best: function () {
      var self = this;
      [0, 7, 12, 19].forEach(function (s, i) {
        self.blip(523.25 * Math.pow(2, s / 12), 0.18, 'sine', 0.075, i * 0.07);
      });
    }
  };

  /* ------------------------------------------------------------ DOM 引用 */

  var boardEl = $('#board');
  var gridEl = $('#grid');
  var tilesEl = $('#tiles');
  var fxEl = $('#fx');
  var scoreEl = $('#score');
  var bestEl = $('#best');
  var scoreBox = $('#score-box');
  var overlay = $('#overlay');
  var ovBadge = $('#ov-badge');
  var ovTitle = $('#ov-title');
  var ovText = $('#ov-text');
  var ovStats = $('#ov-stats');
  var ovScore = $('#ov-score');
  var ovBest = $('#ov-best');
  var ovPrimary = $('#ov-primary');
  var ovSecondary = $('#ov-secondary');
  var btnSound = $('#btn-sound');
  var btnPause = $('#btn-pause');
  var btnRestart = $('#btn-restart');

  var ovShare = $('#ov-share');
  var sharePreview = $('#share-preview');
  var btnShareX = $('#btn-share-x');
  var btnShareLine = $('#btn-share-line');
  var btnSavePng = $('#btn-save-png');
  var btnCopyLink = $('#btn-copy-link');

  /* ------------------------------------------------------------ 运行状态 */

  var metrics = { cell: 0, gap: 0, pad: 0, board: 0 };

  var tiles = [];          // 活动方块
  var grid = [];           // SIZE x SIZE，存方块引用或 null
  var nextId = 1;
  var turn = 0;            // 步数计数，用于"每回合只能合并一次"的判定
  var score = 0;
  var displayScore = 0;
  var best = loadNum(KEY_BEST, 0);
  var newRecord = false;   // 本局是否刷新过最高分

  var state = 'ready';     // ready | playing | paused | won | over
  var phase = 'idle';      // idle | slide | spawn
  var phaseT = 0;
  var pendingMerges = [];
  var queued = null;       // 动画期间缓存一次输入，保证连滑跟手
  var reached2048 = false;

  var shake = { t: 0, mag: 0, dx: 0, dy: 0 };

  /* -------------------------------------------------------------- 棋盘度量 */

  function measure() {
    var w = boardEl.clientWidth;
    if (!w) return;
    metrics.board = w;
    metrics.gap = Math.max(5, Math.round(w * 0.026));
    metrics.pad = metrics.gap;
    metrics.cell = (w - 2 * metrics.pad - (SIZE - 1) * metrics.gap) / SIZE;

    boardEl.style.setProperty('--gap', metrics.gap + 'px');
    boardEl.style.setProperty('--pad', metrics.pad + 'px');
    boardEl.style.setProperty('--cell', metrics.cell + 'px');
    boardEl.style.setProperty('--radius', Math.max(4, Math.round(metrics.cell * 0.12)) + 'px');
  }

  function cellX(c) { return metrics.pad + c * (metrics.cell + metrics.gap); }
  function cellY(r) { return metrics.pad + r * (metrics.cell + metrics.gap); }

  function buildGrid() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < SIZE * SIZE; i++) {
      var d = document.createElement('div');
      d.className = 'cell';
      frag.appendChild(d);
    }
    gridEl.appendChild(frag);
  }

  /* ---------------------------------------------------------------- 方块 */

  function fontFor(value) {
    var digits = String(value).length;
    var factor = digits <= 2 ? 0.44 : digits === 3 ? 0.35 : digits === 4 ? 0.28 : 0.23;
    return Math.max(9, Math.round(metrics.cell * factor));
  }

  function createTile(value, r, c, isNew) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.setAttribute('data-v', value >= 4096 ? '4096' : String(value));
    el.textContent = String(value);
    var t = {
      id: nextId++,
      value: value,
      r: r, c: c, pr: r, pc: c,
      el: el,
      isNew: !!isNew,
      merged: false,
      dead: false,
      mergeTurn: -1,
      pv: 0,
      _tf: '',
      _fk: ''
    };
    el.style.zIndex = isNew ? '3' : '1';
    tilesEl.appendChild(el);
    return t;
  }

  function refreshTile(t) {
    t.el.setAttribute('data-v', t.value >= 4096 ? '4096' : String(t.value));
    t.el.textContent = String(t.value);
    t._fk = '';
  }

  function emptyCells() {
    var out = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (!grid[r][c]) out.push([r, c]);
      }
    }
    return out;
  }

  function spawnRandom() {
    var cells = emptyCells();
    if (!cells.length) return null;
    var pick = cells[(Math.random() * cells.length) | 0];
    var value = Math.random() < 0.9 ? 2 : 4;
    var t = createTile(value, pick[0], pick[1], true);
    grid[pick[0]][pick[1]] = t;
    tiles.push(t);
    return t;
  }

  /* ------------------------------------------------------------ 核心移动 */

  function doMove(dir) {
    var d = DIRS[dir];
    var rows = [0, 1, 2, 3];
    var cols = [0, 1, 2, 3];
    if (d.dr > 0) rows = rows.slice().reverse();
    if (d.dc > 0) cols = cols.slice().reverse();

    var moved = false;
    var merges = [];
    var i, j;

    for (i = 0; i < SIZE; i++) {
      for (j = 0; j < SIZE; j++) {
        var r = rows[i], c = cols[j];
        var t = grid[r][c];
        if (!t) continue;

        t.pr = r;
        t.pc = c;
        var cr = r, cc = c;

        for (;;) {
          var ar = cr + d.dr, ac = cc + d.dc;
          if (ar < 0 || ar >= SIZE || ac < 0 || ac >= SIZE) break;
          var o = grid[ar][ac];

          if (!o) {
            grid[cr][cc] = null;
            grid[ar][ac] = t;
            cr = ar; cc = ac;
            continue;
          }
          if (o.value === t.value && o.mergeTurn !== turn) {
            grid[cr][cc] = null;
            o.mergeTurn = turn;
            o.pv = o.value * 2;
            t.dead = true;
            t.r = ar; t.c = ac;
            t.el.style.zIndex = '2';
            merges.push(o);
            moved = true;
          }
          break;
        }

        if (!t.dead) {
          if (cr !== t.r || cc !== t.c) moved = true;
          t.r = cr;
          t.c = cc;
        }
      }
    }

    if (!moved) {
      shakeIt(dir);
      Sound.blocked();
      return false;
    }

    turn++;
    pendingMerges = merges;
    phase = 'slide';
    phaseT = 0;
    Sound.move();
    return true;
  }

  function shakeIt(dir) {
    var d = DIRS[dir];
    shake.t = SHAKE_MS;
    shake.mag = Math.max(3, metrics.board * 0.012);
    shake.dx = d.dc;
    shake.dy = d.dr;
  }

  /* ------------------------------------------------------- 阶段切换/结算 */

  function endSlide() {
    var i;

    // 1. 移除被吞并的方块
    for (i = tiles.length - 1; i >= 0; i--) {
      if (tiles[i].dead) {
        if (tiles[i].el.parentNode) tiles[i].el.parentNode.removeChild(tiles[i].el);
        tiles.splice(i, 1);
      }
    }

    // 2. 结算合并：翻倍、飘分、更新最高分
    var brokeRecord = false;
    for (i = 0; i < pendingMerges.length; i++) {
      var o = pendingMerges[i];
      o.value = o.pv;
      o.pv = 0;
      o.merged = true;
      o.isNew = false;
      o.el.style.zIndex = '3';
      refreshTile(o);

      score += o.value;
      spawnPop(cellX(o.c) + metrics.cell / 2, cellY(o.r) + metrics.cell / 2, '+' + o.value);
      Sound.merge(o.value);

      if (score > best) {
        if (!newRecord) brokeRecord = true;
        newRecord = true;
        best = score;
        saveNum(KEY_BEST, best);
        bestEl.textContent = String(best);
      }
    }
    pendingMerges = [];
    flashScore();
    if (brokeRecord) Sound.best();

    // 3. 落新方块
    spawnRandom();

    phase = 'spawn';
    phaseT = 0;
  }

  function endSpawn() {
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].isNew = false;
      if (tiles[i].merged) {
        tiles[i].merged = false;
        tiles[i].el.style.zIndex = '1';
      }
    }
    phase = 'idle';
    phaseT = 0;

    if (!reached2048) {
      for (var k = 0; k < tiles.length; k++) {
        if (tiles[k].value >= 2048) {
          reached2048 = true;
          state = 'won';
          Sound.win();
          showOverlay('won');
          return;
        }
      }
    }

    if (isGameOver()) {
      state = 'over';
      Sound.over();
      showOverlay('over');
    }
  }

  function isGameOver() {
    if (emptyCells().length) return false;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var v = grid[r][c].value;
        if (r + 1 < SIZE && grid[r + 1][c].value === v) return false;
        if (c + 1 < SIZE && grid[r][c + 1].value === v) return false;
      }
    }
    return true;
  }

  function spawnPop(x, y, text) {
    var el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    fxEl.appendChild(el);
    var kill = function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.addEventListener('animationend', kill);
    // 兜底：某些浏览器在后台标签页不会派发 animationend
    window.setTimeout(kill, 1200);
  }

  function flashScore() {
    scoreBox.classList.remove('flash');
    // 强制重排以重启动画
    void scoreBox.offsetWidth;
    scoreBox.classList.add('flash');
  }

  /* ------------------------------------------------------------ 渲染循环 */

  var lastTime = 0;

  function loop(now) {
    if (!lastTime) lastTime = now;
    var dt = Math.min(now - lastTime, 60);
    lastTime = now;
    update(dt);
    render();
    window.requestAnimationFrame(loop);
  }

  function update(dt) {
    if (phase !== 'idle') {
      phaseT += dt;
      var dur = phase === 'slide' ? SLIDE_MS : SPAWN_MS;
      if (phaseT >= dur) {
        if (phase === 'slide') endSlide();
        else endSpawn();
      }
    }

    if (shake.t > 0) shake.t = Math.max(0, shake.t - dt);

    if (displayScore !== score) {
      var diff = score - displayScore;
      displayScore += diff * Math.min(1, dt / 90);
      if (Math.abs(score - displayScore) < 0.7) displayScore = score;
      scoreEl.textContent = String(Math.round(displayScore));
    }

    // 缓存的输入在空闲时立刻执行，连滑不丢帧
    if (phase === 'idle' && queued && state === 'playing') {
      var d = queued;
      queued = null;
      doMove(d);
    }
  }

  function render() {
    var i, t, x, y, s, key;

    var slideP = 1;
    if (phase === 'slide') slideP = SLIDE_MS > 0 ? clamp(phaseT / SLIDE_MS, 0, 1) : 1;
    var e = easeInOut(slideP);

    var spawnP = 1;
    if (phase === 'spawn') spawnP = SPAWN_MS > 0 ? clamp(phaseT / SPAWN_MS, 0, 1) : 1;

    for (i = 0; i < tiles.length; i++) {
      t = tiles[i];
      s = 1;

      if (phase === 'slide' && (t.pr !== t.r || t.pc !== t.c)) {
        x = cellX(t.pc) + (cellX(t.c) - cellX(t.pc)) * e;
        y = cellY(t.pr) + (cellY(t.r) - cellY(t.pr)) * e;
      } else {
        x = cellX(t.c);
        y = cellY(t.r);
      }

      if (phase === 'spawn') {
        if (t.isNew) s = 0.25 + 0.75 * easeOutBack(spawnP);
        else if (t.merged) s = 1 + 0.16 * Math.sin(Math.PI * spawnP);
      }

      key = x.toFixed(2) + '|' + y.toFixed(2) + '|' + s.toFixed(3);
      if (t._tf !== key) {
        t.el.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + s.toFixed(3) + ')';
        t._tf = key;
      }

      key = metrics.cell + ':' + t.value;
      if (t._fk !== key) {
        t.el.style.fontSize = fontFor(t.value) + 'px';
        t._fk = key;
      }
    }

    if (shake.t > 0) {
      var k = shake.t / SHAKE_MS;
      var off = Math.sin(k * Math.PI) * shake.mag;
      boardEl.style.transform =
        'translate3d(' + (shake.dx * off).toFixed(2) + 'px,' + (shake.dy * off).toFixed(2) + 'px,0)';
    } else if (boardEl.style.transform) {
      boardEl.style.transform = '';
    }
  }

  /* ------------------------------------------------------------ 状态流转 */

  function startGame() {
    Sound.init();

    var i;
    for (i = 0; i < tiles.length; i++) {
      if (tiles[i].el.parentNode) tiles[i].el.parentNode.removeChild(tiles[i].el);
    }
    tiles = [];
    pendingMerges = [];
    queued = null;
    grid = [];
    for (var r = 0; r < SIZE; r++) {
      grid.push([null, null, null, null]);
    }

    turn = 0;
    score = 0;
    displayScore = 0;
    reached2048 = false;
    newRecord = false;
    shake.t = 0;
    scoreEl.textContent = '0';
    bestEl.textContent = String(best);
    phase = 'idle';
    phaseT = 0;

    spawnRandom();
    spawnRandom();

    state = 'playing';
    hideOverlay();
    syncControls();
    Sound.start();
  }

  function togglePause(force) {
    if (state === 'playing' || state === 'won') {
      if (force === false) return;
      state = 'paused';
      queued = null;
      showOverlay('paused');
    } else if (state === 'paused') {
      if (force === true) return;
      state = reached2048 ? 'won' : 'playing';
      hideOverlay();
    }
    syncControls();
  }

  function syncControls() {
    btnPause.disabled = (state === 'ready' || state === 'over');
    btnPause.setAttribute('data-mode', (state === 'paused') ? 'resume' : 'pause');
    btnPause.setAttribute('aria-label', state === 'paused' ? '继续' : '暂停');
  }

  /* --------------------------------------------------------- 分数分享卡 */
  /* 用 Canvas 画一张 1080×1350 的竖版卡片：大号分数 + 最高分 + 棋盘缩略图 + 回站地址。
     配色全部从 CSS 变量读取，跟随当前主题。零外部依赖，不引 QR 库。 */

  var SHARE_W = 1080;
  var SHARE_H = 1350;
  var SHARE_URL = 'https://www.reveriel.com/web-game/';
  var SHARE_FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", ' +
    '"Noto Sans JP", "PingFang SC", "Microsoft YaHei", -apple-system, "Segoe UI", sans-serif';

  var shareCanvas = null;   // 当前结束面板对应的卡片画布

  function shareFont(weight, size) {
    return weight + ' ' + Math.round(size) + 'px ' + SHARE_FONT;
  }

  function cssVar(name, fallback) {
    try {
      var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /* 方块数值 -> 配色，与 style.css 里的 --t2 / --t2-fg … 一一对应 */
  function tilePalette(value) {
    var key = value >= 4096 ? '--tsuper' : '--t' + value;
    var fgKey = value >= 4096 ? '--tsuper-fg' : '--t' + value + '-fg';
    return { bg: cssVar(key, '#3c3a32'), fg: cssVar(fgKey, '#fffaf4') };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitFont(ctx, text, weight, maxSize, maxWidth) {
    var size = maxSize;
    for (;;) {
      ctx.font = shareFont(weight, size);
      if (ctx.measureText(text).width <= maxWidth || size <= 24) return size;
      size -= 4;
    }
  }

  /* 把当前棋盘抄成 4×4 的数值表，0 表示空格 */
  function snapshotBoard() {
    var out = [];
    for (var r = 0; r < SIZE; r++) {
      var row = [];
      for (var c = 0; c < SIZE; c++) {
        var t = grid[r] ? grid[r][c] : null;
        row.push(t ? t.value : 0);
      }
      out.push(row);
    }
    return out;
  }

  function drawTiles(ctx, snap, x0, y0, size, col) {
    var gap = Math.round(size * 0.026);
    var pad = gap;
    var cell = (size - 2 * pad - (SIZE - 1) * gap) / SIZE;
    var radius = Math.max(4, cell * 0.12);
    var r, c;

    roundRect(ctx, x0, y0, size, size, radius + 8);
    ctx.fillStyle = col.boardBg;
    ctx.fill();

    for (r = 0; r < SIZE; r++) {
      for (c = 0; c < SIZE; c++) {
        var x = x0 + pad + c * (cell + gap);
        var y = y0 + pad + r * (cell + gap);
        var v = snap[r][c];

        roundRect(ctx, x, y, cell, cell, radius);
        if (!v) {
          ctx.fillStyle = col.cellBg;
          ctx.fill();
          continue;
        }
        var pal = tilePalette(v);
        ctx.fillStyle = pal.bg;
        ctx.fill();

        var digits = String(v).length;
        var factor = digits <= 2 ? 0.44 : digits === 3 ? 0.35 : digits === 4 ? 0.28 : 0.23;
        ctx.font = shareFont(800, Math.max(12, cell * factor));
        ctx.fillStyle = pal.fg;
        ctx.textBaseline = 'middle';
        ctx.fillText(String(v), x + cell / 2, y + cell / 2);
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  function drawShareCard(canvas, snap, sc, bs, kind, isRecord) {
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    var ctx = canvas.getContext('2d');
    if (!ctx) return false;

    var col = {
      bg: cssVar('--bg', '#faf8f4'),
      glow: cssVar('--bg-glow', '#f3ece1'),
      text: cssVar('--text', '#453f3a'),
      muted: cssVar('--muted', '#8d8279'),
      accent: cssVar('--accent', '#e8863c'),
      boardBg: cssVar('--board-bg', '#c9bdaf'),
      cellBg: cssVar('--cell-bg', 'rgba(255,255,255,.32)')
    };

    // 背景：顶部晕开的径向渐变，和页面背景一致
    var g = ctx.createRadialGradient(SHARE_W / 2, 0, 0, SHARE_W / 2, 0, SHARE_H * 0.92);
    g.addColorStop(0, col.glow);
    g.addColorStop(1, col.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // 品牌
    ctx.font = shareFont(800, 62);
    ctx.fillStyle = col.text;
    ctx.fillText('2048', SHARE_W / 2, 150);

    // 日文标语：刷新纪录时换成更抓眼的说法
    var slogan = isRecord
      ? 'ベストスコア更新！'
      : (kind === 'won' ? 'あなたの2048最高スコア' : '今回の2048スコア');
    ctx.font = shareFont(700, 40);
    ctx.fillStyle = col.accent;
    ctx.fillText(slogan, SHARE_W / 2, 226);

    // 大号分数
    var scoreStr = String(sc);
    ctx.font = shareFont(800, fitFont(ctx, scoreStr, 800, 190, SHARE_W - 200));
    ctx.fillStyle = col.text;
    ctx.fillText(scoreStr, SHARE_W / 2, 430);

    // 最高分
    ctx.font = shareFont(600, 38);
    ctx.fillStyle = col.muted;
    ctx.fillText('ベストスコア ' + bs, SHARE_W / 2, 510);

    // 棋盘缩略图
    drawTiles(ctx, snap, (SHARE_W - 620) / 2, 570, 620, col);

    // 分隔线 + 回站地址
    ctx.strokeStyle = col.boardBg;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(SHARE_W / 2 - 300, 1238);
    ctx.lineTo(SHARE_W / 2 + 300, 1238);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.font = shareFont(600, 34);
    ctx.fillStyle = col.muted;
    ctx.fillText(SHARE_URL, SHARE_W / 2, 1296);

    return true;
  }

  function buildShareCard(kind, isRecord) {
    var c = document.createElement('canvas');
    var ok = drawShareCard(c, snapshotBoard(), score, best, kind, isRecord);
    return ok ? c : null;
  }

  function buildShareText() {
    var t = '『2048』で ' + score + ' 点とれました';
    if (newRecord) t += '（ベスト更新！）';
    else if (best > 0 && best !== score) t += '／ベスト ' + best + ' 点';
    t += '。同じ数字をくっつけて2048を目指すパズルです。';
    return t;
  }

  function shareOnX() {
    var url = 'https://twitter.com/intent/tweet' +
      '?text=' + encodeURIComponent(buildShareText()) +
      '&url=' + encodeURIComponent(SHARE_URL);
    window.open(url, '_blank', 'noopener,noreferrer,width=600,height=540');
  }

  function saveShareImage() {
    if (!shareCanvas) return;
    var name = '2048-score-' + score + '.png';

    var trigger = function (href, revoke) {
      var a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (revoke) window.setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
    };

    if (shareCanvas.toBlob) {
      shareCanvas.toBlob(function (blob) {
        if (!blob) { trigger(shareCanvas.toDataURL('image/png'), false); return; }
        trigger(URL.createObjectURL(blob), true);
      }, 'image/png');
    } else {
      trigger(shareCanvas.toDataURL('image/png'), false);
    }
  }

  /* 结束面板出现时生成卡片；预览直接把 canvas 缩小摆进去，
     PNG 编码延后到用户点「画像を保存 / Xでシェア」时才做。 */
  function setupShareCard(kind) {
    if (!ovShare || !sharePreview) return;
    clearShareCard();
    shareCanvas = buildShareCard(kind, newRecord);
    if (!shareCanvas) { ovShare.hidden = true; return; }
    sharePreview.appendChild(shareCanvas);
    ovShare.hidden = false;
  }

  function clearShareCard() {
    shareCanvas = null;
    if (sharePreview) sharePreview.textContent = '';
  }

  /* LINE は日本で最も使われる共有先。テキスト + URL を渡すだけの公式シェア画面を開く。 */
  function shareOnLine() {
    var url = 'https://social-plugins.line.me/lineit/share' +
      '?url=' + encodeURIComponent(SHARE_URL) +
      '&text=' + encodeURIComponent(buildShareText());
    window.open(url, '_blank', 'noopener,noreferrer,width=600,height=600');
  }

  /* リンクをコピー：成功したらボタン文言を一時的に差し替えて知らせる。 */
  function copyShareLink() {
    var label = btnCopyLink ? btnCopyLink.textContent : '';
    var flash = function (text) {
      if (!btnCopyLink) return;
      btnCopyLink.textContent = text;
      window.setTimeout(function () { btnCopyLink.textContent = label; }, 1600);
    };
    var legacy = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = SHARE_URL;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        flash(ok ? 'コピーしました' : 'コピーできません');
      } catch (e) { flash('コピーできません'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(SHARE_URL).then(function () {
        flash('コピーしました');
      }, legacy);
    } else {
      legacy();
    }
  }

  if (btnShareX) btnShareX.addEventListener('click', shareOnX);
  if (btnShareLine) btnShareLine.addEventListener('click', shareOnLine);
  if (btnSavePng) btnSavePng.addEventListener('click', saveShareImage);
  if (btnCopyLink) btnCopyLink.addEventListener('click', copyShareLink);

  /* -------------------------------------------------------------- 遮罩层 */

  function showOverlay(kind) {
    var cfg = {
      ready: {
        badge: true,
        title: '2048',
        text: '滑动合并相同数字，凑出 2048 方块。',
        stats: false,
        primary: '开始游戏',
        secondary: null
      },
      paused: {
        badge: false,
        title: '已暂停',
        text: '随时回来继续这一局。',
        stats: false,
        primary: '继续游戏',
        secondary: '重新开始'
      },
      won: {
        badge: true,
        title: '达成 2048!',
        text: '厉害，还能走多远？',
        stats: false,
        primary: '继续挑战',
        secondary: '重新开始',
        share: true
      },
      over: {
        badge: false,
        title: newRecord ? '新纪录!' : '游戏结束',
        text: newRecord ? '刷新了本机最高分。' : '没有可移动的方块了。',
        stats: true,
        primary: '再来一局',
        secondary: null,
        share: true
      }
    }[kind];

    ovBadge.hidden = !cfg.badge;
    ovTitle.textContent = cfg.title;
    ovText.textContent = cfg.text;

    ovStats.hidden = !cfg.stats;
    if (cfg.stats) {
      ovScore.textContent = String(score);
      ovBest.textContent = String(best);
    }

    ovPrimary.textContent = cfg.primary;
    ovSecondary.hidden = !cfg.secondary;
    if (cfg.secondary) ovSecondary.textContent = cfg.secondary;

    // 分数分享卡只在本局结束（胜利 / 无路可走）时出现
    if (ovShare && sharePreview) {
      if (cfg.share) {
        setupShareCard(kind);
      } else {
        // 分享卡用完即弃，别把 1080×1350 的画布留在内存里
        ovShare.hidden = true;
        clearShareCard();
      }
    }

    ovPrimary.onclick = function () {
      Sound.init();
      if (kind === 'ready' || kind === 'over') startGame();
      else if (kind === 'paused' || kind === 'won') togglePause();
    };

    ovSecondary.onclick = function () {
      Sound.init();
      startGame();
    };

    overlay.hidden = false;
    overlay.setAttribute('data-kind', kind);
    // 让主按钮接管焦点，方便键盘用户
    window.setTimeout(function () { ovPrimary.focus(); }, 30);
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlay.removeAttribute('data-kind');
    if (ovShare) {
      ovShare.hidden = true;
      clearShareCard();
    }
  }

  /* ------------------------------------------------------------------ 输入 */

  function handleDir(dir) {
    Sound.init();
    if (state === 'ready') { startGame(); return; }   // 直接按方向键也能开局
    if (state === 'over') return;
    if (state === 'paused') { togglePause(); return; }
    if (state === 'won') {
      // 胜利面板还没关掉时，先关掉再走
      state = 'playing';
      hideOverlay();
      syncControls();
    }
    if (phase !== 'idle') { queued = dir; return; }
    doMove(dir);
  }

  function dirFromKey(key) {
    switch (key) {
      case 'ArrowUp': case 'w': case 'W': return 'up';
      case 'ArrowDown': case 's': case 'S': return 'down';
      case 'ArrowLeft': case 'a': case 'A': return 'left';
      case 'ArrowRight': case 'd': case 'D': return 'right';
      default: return null;
    }
  }

  window.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    var dir = dirFromKey(ev.key);
    if (dir) {
      ev.preventDefault();
      handleDir(dir);
      return;
    }
    if (ev.key === 'p' || ev.key === 'P') {
      ev.preventDefault();
      if (state === 'ready') startGame(); else togglePause();
    } else if (ev.key === 'r' || ev.key === 'R') {
      ev.preventDefault();
      startGame();
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      if (state === 'ready' || state === 'over') {
        ev.preventDefault();
        startGame();
      }
    }
  }, { passive: false });

  /* --- 滑动：阈值触发，一次触摸只判定一次方向 --- */

  var touch = null;

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    Sound.init();
    touch = {
      id: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      used: false
    };
  }

  function onPointerMove(ev) {
    if (!touch || touch.used || ev.pointerId !== touch.id) return;
    var dx = ev.clientX - touch.x;
    var dy = ev.clientY - touch.y;
    var th = Math.max(18, metrics.board * 0.055);

    if (Math.abs(dx) < th && Math.abs(dy) < th) return;

    touch.used = true;
    if (Math.abs(dx) > Math.abs(dy)) {
      handleDir(dx > 0 ? 'right' : 'left');
    } else {
      handleDir(dy > 0 ? 'down' : 'up');
    }
  }

  function onPointerUp(ev) {
    if (!touch || ev.pointerId !== touch.id) return;
    // 轻点也算一次：未达阈值时不触发移动
    touch = null;
  }

  boardEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });

  // 触摸拖动不能带着页面一起滚
  boardEl.addEventListener('touchmove', function (ev) {
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });

  /* -------------------------------------------------------------- 控件绑定 */

  btnRestart.addEventListener('click', function () {
    Sound.init();
    startGame();
  });

  btnPause.addEventListener('click', function () {
    Sound.init();
    if (state === 'ready') { startGame(); return; }
    togglePause();
  });

  btnSound.addEventListener('click', function () {
    Sound.init();
    Sound.muted = !Sound.muted;
    saveNum(KEY_MUTED, Sound.muted ? 1 : 0);
    btnSound.setAttribute('aria-pressed', Sound.muted ? 'false' : 'true');
    if (!Sound.muted) Sound.merge(4);
  });

  // 切到后台自动暂停，回来不至于"少算"一局
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (state === 'playing' || state === 'won') togglePause(true);
    } else {
      lastTime = 0;
    }
  });

  window.addEventListener('blur', function () {
    if (state === 'playing' || state === 'won') togglePause(true);
  });

  /* ------------------------------------------------------------------ 启动 */

  var resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      measure();
      // 尺寸变化后强制重算一次位置与字号
      for (var i = 0; i < tiles.length; i++) { tiles[i]._tf = ''; tiles[i]._fk = ''; }
    }, 60);
  }

  if (window.ResizeObserver) {
    new ResizeObserver(onResize).observe(boardEl);
  } else {
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  buildGrid();
  measure();
  bestEl.textContent = String(best);
  btnSound.setAttribute('aria-pressed', Sound.muted ? 'false' : 'true');
  // 初始棋盘先摆两个方块，让首屏不至于空着
  grid = [];
  for (var rr = 0; rr < SIZE; rr++) grid.push([null, null, null, null]);
  spawnRandom();
  spawnRandom();
  syncControls();
  showOverlay('ready');
  window.requestAnimationFrame(loop);
})();
