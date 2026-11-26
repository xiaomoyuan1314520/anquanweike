// ==UserScript==
// @name         安全微伴 · 自动挂机助手
// @namespace    wb-auto-study
// @version      1.16.2
// @description  自动点击「开始学习 / 继续学习 / 下一页」、自动打开未完成课程；可选接入 DeepSeek 作答选择题与互动小游戏。纯本地运行，不读取、不上传账号密码。
// @author       WorkBuddy
// @match        *://weiban.mycourse.cn/*
// @match        *://mcwk.mycourse.cn/*
// @match        *://*.mycourse.cn/*
// @match        *://*/*
// 说明：课件经常被塞进「非 mycourse.cn 域名」的 iframe 里（跨域），
// 那种情况下只写 mycourse.cn 的匹配等于帧内没脚本，顶层又扫不到内容，表现就是
// 面板一直显示"本页暂无可点元素、已点击 0 次"。所以放宽到全域，
// 但脚本开头会用 referrer 判定是否属于微伴体系，其它网站毫秒级退出、不做任何事。
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.deepseek.com
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  if (window.__WB_AUTO_STUDY_LOADED__) return;
  window.__WB_AUTO_STUDY_LOADED__ = true;

  const FRAME_MSG = 'wb-auto-study';

  /**
   * 只在"微伴体系内"生效：
   *   1) 本页就是 *.mycourse.cn；
   *   2) 或者本页是被 mycourse.cn 页面用 iframe 加载的课件页
   *      —— 此时课件域名往往完全是另一个域，只能靠 document.referrer 认出来；
   *   3) 再兜底看一眼 top 域名（跨域读不到就算了）。
   * 其它网站直接在毫秒级返回，不建面板、不监听、不发请求。
   */
  function inWeibanContext() {
    try {
      if (/mycourse\.cn$/i.test(location.hostname)) return true;
    } catch (e) { /* 忽略 */ }

    let ref = '';
    try { ref = document.referrer || ''; } catch (e) { ref = ''; }
    if (/mycourse\.cn/i.test(ref)) return true;

    // Chrome/Edge：即使 iframe 设了 no-referrer，也能从 ancestorOrigins 拿到父页来源
    try {
      const origins = location.ancestorOrigins;
      if (origins && origins.length) {
        for (let i = 0; i < origins.length; i++) {
          if (/mycourse\.cn/i.test(origins[i] || '')) return true;
        }
      }
    } catch (e) { /* 不支持就算了 */ }

    // 自己的地址里带微伴域名（常见于 ?from=weiban.mycourse.cn 这类参数）
    try {
      if (/mycourse\.cn/i.test(location.href)) return true;
    } catch (e) { /* 忽略 */ }

    try {
      if (window.top && /mycourse\.cn$/i.test(window.top.location.hostname)) return true;
    } catch (e) { /* 跨域读不到 top，正常 */ }

    return false;
  }

  const IS_TOP = window.top === window.self;

  /**
   * iframe 待命模式。
   * 现实：课件的域名五花八门（甚至每次不一样），referrer 还经常被抹掉，
   * 靠"把域名加进白名单"永远追不上。所以改成父页面授权：
   * 顶层本来就是微伴页面，它发一句 activate 就等于认证"这一帧是我嵌的"。
   * 于是这里不退出，只挂一个监听等父页放行。
   */
  function startFrameStandby() {
    let started = false;
    let timer = null;
    let tries = 0;

    const onMessage = function (e) {
      const data = e.data;
      if (!data || data.wb !== FRAME_MSG) return;
      if (data.action !== 'activate') return;
      if (started) return;

      started = true;
      try { window.removeEventListener('message', onMessage); } catch (err) { /* 忽略 */ }
      if (timer) { clearInterval(timer); timer = null; }
      main();
    };

    window.addEventListener('message', onMessage);

    const announce = function () {
      try {
        window.top.postMessage({
          wb: FRAME_MSG,
          action: 'ctx-fail',
          host: location.hostname,
          href: String(location.href).slice(0, 140),
          referrer: document.referrer || ''
        }, '*');
      } catch (err) { /* 忽略 */ }
    };

    announce();
    // 父页可能比这一帧晚就绪，多喊几声
    timer = setInterval(function () {
      if (started || tries++ > 20) { clearInterval(timer); timer = null; return; }
      announce();
    }, 800);
  }

  if (!IS_TOP && !inWeibanContext()) {
    startFrameStandby();
    return;
  }
  if (!inWeibanContext()) return;   // 顶层且不属于微伴：毫秒级退出，什么都不做

  main();

  function main() {
    // 帧可能被激活多次（父页重复喊话说），这里只真正启动一次
    if (window.__WB_MAIN_STARTED__) return;
    window.__WB_MAIN_STARTED__ = true;

  /* ==================================================================
   * 一、配置区
   * ================================================================== */
  const CONFIG = {
    // 轮询间隔：5-8 秒太密，容易被判定为机器行为，改为 15-30 秒
    scan: {
      // 核心诉求是"快"：顶层 6-10 秒、课件帧 4-7 秒（帧内覆盖值在 bootstrap 里）。
      // 都是本地 DOM 查询，不发请求，只是模拟人工间隔
      minInterval: 1000, maxInterval: 2000, firstDelay: 500,
      idleMinInterval: 800, idleMaxInterval: 1500
    },
    // 点击节奏：简单直接——延迟→点击→0.8 秒后复查，没有冷却、没有"点不动"拉黑
    click: { minDelay: 300, maxDelay: 600, postClickPause: 800 },
    observe: { debounce: 250, minGap: 1200 },
    guard: {
      maxClicksPerPage: 40,
      pauseOnExamPage: true,
      // 默认关闭：验证码本来就要人来点，脚本停手反而带来"跳过等待传不到帧内、
      // 隐藏验证码误判"等一连串卡顿。关掉后脚本照常跑，你手动拖完验证码它自然继续
      captchaPause: false,
      captchaPollMs: 1200,     // 多久检查一次验证是否完成
      alertSound: true,        // 需要人工介入时响一声
      restEvery: 8,            // 每点 8 次停顿一次；设 0 表示完全不休息
      restMinMs: 2000,         // 固定停 2 秒
      restMaxMs: 2000
    },
    list: {
      autoOpenCourse: true,
      minCards: 2,          // 类名识别：至少 2 张才算列表，避免误点单张横幅
      textMax: 90,
      thumbMinWidth: 56,    // 结构识别：缩略图最小尺寸
      thumbMinHeight: 36,
      rowTextMax: 120       // 结构识别：一张卡片的文字上限
    },
    // 几何识别：不依赖颜色/类名，靠"底部左右成对的按钮"判断哪个是下一页
    geometry: { enabled: true, minWidth: 48, maxWidth: 280, minHeight: 20, maxHeight: 110, bandRatio: 0.72 },
    picker: { maxCustom: 10 },
    quiz: {
      enabled: false,
      // 多选题默认"全选"：这类安全微课题库里，多选基本就是全部正确；
      // 想改成交给 AI 判断，把它设为 false
      multiSelectAll: true,
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      // 图片题用视觉模型识图（DeepSeek 官方：deepseek-v4-flash-vision-exp）。
      // 同一把 key、同一个 endpoint，只是 model 不同。识图失败会自动退回穷举组合。
      visionModel: 'deepseek-v4-flash-vision-exp',
      visionEnabled: true,
      // 整道题画在一张图上、DOM 里没有独立选项元素时，按这个比例在题图上点选项方块。
      // 方块在右侧、三个选项纵向排列（实测课件布局）。
      imageOptionX: 0.80,                       // 方块横向位置（题图宽度比例）
      imageOptionRows: [0.44, 0.60, 0.76],      // A/B/C 方块纵向位置（题图高度比例）
      // 找不到任何按钮时，让 AI 看着课件画面判断点哪里（0=关闭）
      aiFindClick: true,
      aiFindAfter: 6,          // 连续空转多少次后求助 AI
      aiFindCooldownMs: 20000, // 两次 AI 定位的最小间隔（避免反复调用烧钱）
      temperature: 0,
      timeout: 20000,
      submitAfterAnswer: true,
      submitDelay: 3000
    },
    interactive: {
      enabled: false,
      maxActionsPerPage: 20,
      minGapBetweenActions: 2500,
      sameSceneCooldown: 5000,
      maxNodes: 28,
      promptTextMax: 120,
      nodeTextMax: 40
    }
  };

  const BUTTON_RULES = [
    {
      // 答题结果页：「回答正确 → 点击继续」「回答错误 → 返回重选」。
      // 必须排在「继续学习/下一页」前面，否则会被泛化的"继续"抢先匹配。
      name: '继续答题',
      keywords: ['点击继续', '继续答题', '继续作答', '下一题', '返回重选', '重新选择', '再试一次', '重试本题'],
      selectors: ['[class*="btn-continue"]', '[class*="btn-retry"]', '[class*="btn-again"]']
    },
    {
      name: '开始学习',
      keywords: ['开始学习', '开始课程', '开始上课', '立即学习', '进入学习'],
      selectors: ['.btn-start', '[class*="btn-start"]']
    },
    {
      name: '继续学习',
      keywords: ['继续学习', '继续课程', '继续观看', '继续上课'],
      selectors: []
    },
    {
      // 知识问答页的确认按钮。requireQuiz 保证只在"页面上真有勾选框"时才点，
      // 避免在考试成绩确认框、协议弹窗里误点「确定」
      name: '确认答题',
      keywords: ['点击确定', '确认提交', '提交答案'],
      selectors: [],
      requireQuiz: true
    },
    {
      // 微课完成弹窗里的返回入口，点它才算走完结算
      name: '返回列表',
      keywords: ['返回列表', '返回课程列表', '完成学习', '返回课程'],
      selectors: ['[class*="back-list"]', '[class*="backList"]']
    },
    {
      // 微课最后一页的「开始测试 / 开始考试」是唯一的下一步。
      // 它必须排在「下一页」前面：那一页常常还留着一个点了没反应的「下一页」，
      // 排后面就会一直撞那个死按钮（实测拉黑过一次，整段就卡住了）
      name: '开始测试',
      keywords: ['开始测试', '开始考试', '开始答题', '进入测试', '进入考试', '开始测验', '去测试'],
      selectors: []
    },
    {
      name: '下一页',
      keywords: ['下一页', '下一章节', '下一章', '下一节', '下页'],
      selectors: ['.btn-next', '.btn-next1', '.btn-next-end', '.btn-ce', '[class*="btn-next"]']
    },
    {
      name: '提交评价',
      keywords: ['提交评价', '完成评价', '提交并返回', '评价完成'],
      selectors: ['[class*="btn-submit"]', '[class*="btn-comment"]'],
      onlyOn: /#\/wk\/comment/
    },
    { name: '打开课程', keywords: [], selectors: [], cardLike: true }
  ];

  const MAX_TEXT_LEN = 24;

  const CANDIDATE_SELECTOR = [
    'a', 'button', 'input[type="button"]', 'input[type="submit"]', '[role="button"]',
    '[class*="btn"]', '[class*="Btn"]', '[class*="BTN"]', '[class*="button"]',
    '[class*="next"]', '[class*="Next"]'
  ].join(',');

  const QUIZ_SELECTORS = {
    stem: [
      '.question-title', '.q-title', '.topic-title', '.title-text',
      '[class*="question-title"]', '[class*="questionTitle"]',
      '[class*="stem"]', '[class*="timu"]', '[class*="subject"]'
    ],
    option: [
      '.option-item', '.option', '.answer-item', '.choice-item',
      '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice"]', '[class*="answer"] li'
    ],
    submit: [
      '.submit-btn', '.submit', '[class*="submit"]',
      '.btn-aq', '[class*="btn-aq"]', '[class*="btn-submit"]'
    ]
  };

  const SCENE_ROOT_SELECTORS = [
    '[class*="game"]', '[class*="Game"]', '[class*="interactive"]', '[class*="h5"]',
    '[class*="puzzle"]', '[class*="drag"]', '[class*="activity"]', '[class*="mini"]', 'canvas'
  ];

  const SCENE_NODE_SELECTOR = [
    'button', '[role="button"]', 'a', 'li', 'img',
    '[class*="item"]', '[class*="Item"]', '[class*="card"]', '[class*="option"]',
    '[class*="target"]', '[class*="tile"]', '[class*="piece"]', '[class*="btn"]'
  ].join(',');

  const SCENE_PROMPT_SELECTOR = [
    'h1', 'h2', 'h3', 'h4', 'p',
    '[class*="title"]', '[class*="tip"]', '[class*="desc"]',
    '[class*="prompt"]', '[class*="question"]', '[class*="rule"]'
  ].join(',');

  /* ==================================================================
   * 二、基础工具
   * ================================================================== */
  const now = () => Date.now();

  function rand(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }

  function normalizeText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\s\u00a0\u3000]+/g, ' ')
      .replace(/[›>»→…\.·]+/g, ' ')
      .trim();
  }

  function elementText(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return normalizeText(el.value || '');
    return normalizeText(el.innerText || el.textContent || '');
  }

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ==================================================================
   * 三、存储（油猴 API 优先，跨 iframe 共享）
   * ================================================================== */
  const Store = (function () {
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const PREFIX = 'wb_auto_';

    return {
      get: function (key, fallback) {
        try {
          if (hasGM) {
            const raw = GM_getValue(key, null);
            return raw == null ? fallback : JSON.parse(raw);
          }
          const raw = window.localStorage.getItem(PREFIX + key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch (e) {
          return fallback;
        }
      },
      set: function (key, value) {
        try {
          const raw = JSON.stringify(value);
          if (hasGM) GM_setValue(key, raw);
          else window.localStorage.setItem(PREFIX + key, raw);
          return true;
        } catch (e) {
          return false;
        }
      }
    };
  })();

  /* ==================================================================
   * 四、运行时状态
   * ================================================================== */
  const state = {
    running: true,
    scanning: false,
    answering: false,
    clickCount: 0,
    pageClicks: 0,
    lastAction: '脚本已注入，准备检查页面',
    lastScanAt: 0,
    nextScanAt: 0,
    lastAnsweredKey: '',
    lastAnsweredAt: 0,
    imageTries: {},      // 图片题：每个题目试过的答案组合序号
    imageTriedAnswers: {}, // 图片题：每题已试过的答案签名（避免重复撞同一错误答案）
    aiFindAt: 0,         // 上次让 AI 帮忙定位按钮的时间
    aiFinding: false,    // AI 定位请求进行中
    quizHintShown: false,
    quizMissLogged: false,
    customMissLogged: false,
    captchaActive: false,
    captchaSelector: '',
    sinceRest: 0,
    resting: false,      // 是否处于"长休息"
    restUntil: 0,        // 休息结束时间
    zeroScans: 0,        // 连续"一个候选都没有"的次数
    idleFast: false,     // 本轮是否该用快查间隔
    scanStartedAt: 0,    // 本轮扫描开始时间，看门狗用来判断卡死
    frameClicks: 0,      // iframe 里发生的点击（顶层面板汇总显示）
    frameStatus: null,   // 最近一次由课件帧回传的状态文字 {text, at, host}
    route: location.href
  };

  const LOGS = [];
  // 全文档 DOM 变动计数。课件页常有动画/换图，文字却不变；
  // 用"这段时间页面到底动没动"来判断点击有没有效果，比只看文字靠谱得多
  let mutationTick = 0;
  // 顶层面板收集：哪些 iframe 里的脚本真的跑起来了（每帧启动时喊一声）
  const FRAMES_SEEN = [];
  // 被父页面放行（不靠域名白名单）启动起来的帧域名
  const FRAMES_ACTIVATED = [];
  // 顶层发起"扫描诊断"时，各帧回传的报告片段 [{host, lines}]
  let FRAME_REPORTS = [];
  let scanTimer = null;
  let clickTimer = null;
  let observeTimer = null;
  let uiTimer = null;
  let pickerActive = false;
  let pickerHandler = null;
  let pickerKeyHandler = null;
  const clickedAtMap = new WeakMap();

  /* ==================================================================
   * 五、日志
   * ================================================================== */
  function log(msg, level) {
    const line = {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      msg: String(msg),
      level: level || 'info'
    };
    LOGS.push(line);
    if (LOGS.length > 20) LOGS.shift();

    const prefix = '[安全微伴自动挂机]';
    if (line.level === 'warn') console.warn(prefix, line.msg);
    else if (line.level === 'error') console.error(prefix, line.msg);
    else console.log(prefix, line.msg);

    if (!IS_TOP) {
      // iframe 里没有面板，把关键日志抛给顶层显示
      postToTop({ wb: FRAME_MSG, action: 'log', msg: line.msg, level: line.level });
    }
    renderLogs();
  }

  /* ==================================================================
   * 六、多文档查询（同源 iframe 直接穿透；跨域靠各 frame 自己处理）
   * ================================================================== */
  function collectDocuments() {
    const docs = [];
    const walk = function (doc, depth) {
      if (!doc || docs.indexOf(doc) !== -1) return;
      docs.push(doc);
      if (depth >= 2) return;

      let frames = [];
      try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (let i = 0; i < frames.length; i++) {
        let inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; }
        if (inner && inner.body) walk(inner, depth + 1);
      }
    };
    walk(document, 0);
    return docs;
  }

  /**
   * 查询范围：顶层文档 + 同源 iframe 文档 + 它们的 shadow root。
   * 有些课件用 Web Component 渲染，内容全在 shadow DOM 里，
   * 只查 document 会一个元素都拿不到。
   */
  function collectRoots() {
    const roots = [];
    const docs = collectDocuments();

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      roots.push(doc);
      let found = 0;
      try {
        const els = doc.querySelectorAll('*');
        for (let j = 0; j < els.length && found < 20; j++) {
          if (els[j].shadowRoot) {
            roots.push(els[j].shadowRoot);
            found++;
          }
        }
      } catch (e) { /* 忽略 */ }
    }
    return roots;
  }

  function queryAllDeep(selector) {
    const out = [];
    const docs = collectRoots();
    for (let i = 0; i < docs.length; i++) {
      let nodes = [];
      try { nodes = docs[i].querySelectorAll(selector); } catch (e) { continue; }
      for (let j = 0; j < nodes.length; j++) out.push(nodes[j]);
    }
    return out;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const rect = rects[0];
    if (rect.width < 2 || rect.height < 2) return false;

    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const style = view.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0' || style.opacity === '0.0') return false;
    if (style.pointerEvents === 'none') return false;
    return true;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return /\b(disabled|is-disabled|disable)\b/i.test(cls);
  }

  function depthOf(el) {
    let d = 0;
    let node = el;
    while (node && node.parentElement) {
      d++;
      node = node.parentElement;
    }
    return d;
  }

  function inPanel(el) {
    return !!(el && el.closest && el.closest('#wb-auto-panel'));
  }

  /* ==================================================================
   * 七、自定义选择器（用户在面板里「选取元素」记下的）
   * ================================================================== */
  function getCustomSelectors() {
    const list = Store.get('custom_selectors', []);
    if (!Array.isArray(list)) return [];
    return list.filter(function (s) { return typeof s === 'string' && s; });
  }

  function saveCustomSelector(selector) {
    const list = getCustomSelectors();
    if (list.indexOf(selector) !== -1) return false;
    if (list.length >= CONFIG.picker.maxCustom) return false;
    list.push(selector);
    Store.set('custom_selectors', list);
    return true;
  }

  function clearCustomSelectors() {
    Store.set('custom_selectors', []);
  }

  /* ==================================================================
   * 八、按钮查找
   * ================================================================== */
  /** 页面上是否存在成组的勾选框（用来判断"这是题目页"） */
  function hasFormQuiz() {
    let count = 0;
    const inputs = queryAllDeep('input[type="radio"], input[type="checkbox"]');
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (inPanel(input)) continue;
      const holder = labelOfInput(input) || input.parentElement;
      if (holder && isVisible(holder)) count++;
      if (count >= 2) return true;
    }
    return false;
  }

  function ruleAllowed(rule) {
    if (!rule) return false;
    if (rule.onlyOn && !rule.onlyOn.test(location.href)) return false;
    if (rule.requireQuiz && !hasFormQuiz()) return false;
    // 开了 AI 答题时，"点击确定"要留给答题模块在选完选项之后点，
    // 否则会出现"还没选就提交"的空答案
    if (rule.requireQuiz && CONFIG.quiz.enabled) return false;
    return true;
  }

  /**
   * 点内层 span/img 通常没反应，向上找真正承载点击的节点。
   * 只在"像按钮"的祖先上停：button/a/role=button/class 含 btn/onclick，
   * 一旦爬到文字很长的容器就停，避免把整张卡片当按钮。
   */
  function resolveClickTarget(el) {
    if (!el || el.nodeType !== 1) return el;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL') return el;
    if (el.getAttribute && el.getAttribute('role') === 'button') return el;

    let node = el;
    for (let depth = 0; depth < 3 && node && node.parentElement; depth++) {
      node = node.parentElement;
      if (!node || node.nodeType !== 1) break;
      if (node === document.body || node === document.documentElement) break;

      const nodeTag = node.tagName;
      const cls = typeof node.className === 'string' ? node.className : '';
      const looksButton = nodeTag === 'BUTTON' || nodeTag === 'A' ||
        (node.getAttribute && node.getAttribute('role') === 'button') ||
        /(^|[\s_-])(btn|button)([\s_-]|$)/i.test(cls) ||
        (node.hasAttribute && node.hasAttribute('onclick'));
      if (looksButton) return node;

      const text = elementText(node);
      if (text && text.length > 40) break;
    }
    return el;
  }

  function matchRule(text) {
    for (let i = 0; i < BUTTON_RULES.length; i++) {
      const rule = BUTTON_RULES[i];
      for (let j = 0; j < rule.keywords.length; j++) {
        if (text.indexOf(rule.keywords[j]) !== -1) return rule;
      }
    }
    return null;
  }

  /** 课程列表页的整块卡片：没有按钮文字，只能按结构认 */
  /** 关键字必须"几乎就是整段文字"，避免把正文段落里提到「下一页」的句子当按钮 */
  function matchExactRule(text) {
    for (let i = 0; i < BUTTON_RULES.length; i++) {
      const rule = BUTTON_RULES[i];
      if (rule.cardLike || !rule.keywords.length) continue;
      for (let j = 0; j < rule.keywords.length; j++) {
        const k = rule.keywords[j];
        if (text === k) return rule;
        // 允许「下一页 ›」「下一页>>」这类带箭头后缀的写法
        if (text.indexOf(k) === 0 && text.length - k.length <= 3) return rule;
      }
    }
    return null;
  }

  /**
   * 按"页面上真实存在的短文字"直搜按钮。
   * 课件页的翻页按钮经常是 <div class="xxx">下一页</div>：标签不是 a/button、
   * 类名里也没有 btn/next，只靠选择器查询必然漏掉。这里改扫文本节点。
   */
  function collectTextButtonCandidates() {
    const found = [];
    const seenEls = [];
    const roots = collectRoots();

    for (let d = 0; d < roots.length; d++) {
      const root = roots[d];
      if (!root) continue;

      const isDoc = root.nodeType === 9;
      const ownerDoc = isDoc ? root : (root.ownerDocument || document);
      const host = isDoc ? root.body : root;
      if (!host) continue;

      let walker = null;
      try {
        const view = ownerDoc.defaultView || window;
        const SHOW_TEXT = (view.NodeFilter && view.NodeFilter.SHOW_TEXT) || 4;
        walker = ownerDoc.createTreeWalker(host, SHOW_TEXT, null, false);
      } catch (e) {
        continue;
      }

      let node = walker.nextNode();
      let guard = 0;
      while (node && guard++ < 6000) {
        const text = normalizeText(node.nodeValue);
        if (text && text.length <= 12) {
          const rule = matchExactRule(text);
          if (rule && ruleAllowed(rule)) {
            let el = node.parentElement;
            if (el && !inPanel(el)) {
              el = resolveClickTarget(el);
              if (el && seenEls.indexOf(el) === -1 && isVisible(el) && !isDisabled(el)) {
                const rect = el.getClientRects()[0];
                if (rect && rect.width >= 20 && rect.height >= 12) {
                  seenEls.push(el);
                  found.push({ el: el, text: text, rule: rule });
                }
              }
            }
          }
        }
        node = walker.nextNode();
      }
    }
    return found;
  }

  /** 像"可以被点开"的容器：a/button/带 onclick/类名像卡片/鼠标是手型 */
  function clickableLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON') return true;
    if (el.getAttribute && (el.getAttribute('onclick') || el.getAttribute('role') === 'button')) return true;

    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(course|lesson|chapter|subject|item|card|list|unit|study|ke)/i.test(cls)) return true;

    try {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (view.getComputedStyle && view.getComputedStyle(el).cursor === 'pointer') return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function collectCardCandidates() {
    if (!CONFIG.list.autoOpenCourse) return [];
    if (location.host.indexOf('weiban.mycourse.cn') === -1) return [];

    const route = location.pathname + location.hash;
    if (!/(course|index|home|list)/i.test(route)) return [];
    // 已经进到课件/考试页了，就不要再当列表页找卡片（课件页里也有大量图片）
    if (/detail|exam|wk\//i.test(route)) return [];

    const BLOCK_WORDS = ['考试', '已完成', '已学完', '学习足迹', '课程搜索', '查看更多', '我的课程'];
    const blocked = function (text) {
      for (let j = 0; j < BLOCK_WORDS.length; j++) {
        if (text.indexOf(BLOCK_WORDS[j]) !== -1) return true;
      }
      return false;
    };

    /* 第一轮：类名命中（很多学校皮肤确实是 course-item 这类命名） */
    const CARD_SELECTOR = [
      '[class*="course-item"]', '[class*="courseItem"]', '[class*="course-list"] li',
      '[class*="course_list"] li', '[class*="course"] li', '[class*="list-item"]', '[class*="card"]'
    ].join(',');

    const byClass = [];
    const classNodes = queryAllDeep(CARD_SELECTOR);
    for (let i = 0; i < classNodes.length; i++) {
      const el = classNodes[i];
      if (inPanel(el) || !isVisible(el) || isDisabled(el)) continue;
      const text = elementText(el);
      if (!text || text.length < 4 || text.length > CONFIG.list.textMax) continue;
      if (!el.querySelector('img')) continue;
      if (blocked(text)) continue;
      byClass.push({ el: el, text: text });
    }
    if (byClass.length >= CONFIG.list.minCards) return byClass;

    /* 第二轮：完全不猜类名，用"缩略图 + 短文字 + 可点击"三件套认卡片。
       你截图里那种卡片（缩略图 + 标题 + 分类 + 点赞数）就是靠这一轮认出来的。 */
    const strict = [];   // 明确"像可点"的行
    const loose = [];    // 只是"缩略图 + 短文字"，靠"存在多行"来判断是列表
    const usedStrict = [];
    const usedLoose = [];
    const imgs = queryAllDeep('img');

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (inPanel(img) || !isVisible(img)) continue;

      const ir = img.getClientRects ? img.getClientRects()[0] : null;
      if (!ir) continue;
      if (ir.width < CONFIG.list.thumbMinWidth || ir.height < CONFIG.list.thumbMinHeight) continue;
      if (ir.width > 420 || ir.height > 320) continue;   // 太大的通常是横幅/背景图

      let node = img.parentElement;
      for (let k = 0; k < 4 && node; k++) {
        if (inPanel(node) || node === document.body) break;
        if (node.closest && node.closest('nav,footer,header')) break;

        const r = node.getClientRects ? node.getClientRects()[0] : null;
        const text = elementText(node);

        if (r && text && text.length >= 4 && text.length <= CONFIG.list.rowTextMax &&
            r.height >= 36 && r.height <= 220) {
          const isClickable = clickableLike(node);

          const pushTo = function (bucket, used) {
            for (let m = 0; m < used.length; m++) {
              if (used[m] === node || used[m].contains(node) || node.contains(used[m])) return;
            }
            used.push(node);
            bucket.push({ el: node, text: text });
          };

          if (isClickable) pushTo(strict, usedStrict);
          else pushTo(loose, usedLoose);   // 先记着，下面再决定要不要用
          break;
        }
        node = node.parentElement;
      }
    }

    if (strict.length) return strict;
    // 页面上有多行"缩略图 + 短文字"时，基本可以确认是课程列表（横幅不会成排出现）
    if (loose.length >= 2) return loose;
    return byClass.length >= CONFIG.list.minCards ? byClass : [];
  }

  function collectCandidates() {
    const list = [];
    const accepted = [];

    const accept = function (el, rule, text) {
      if (accepted.indexOf(el) !== -1) return;
      if (inPanel(el) || !isVisible(el) || isDisabled(el)) return;

      accepted.push(el);
      list.push({ el: el, text: text || rule.name, rule: rule, depth: depthOf(el) });
    };

    // 第零轮：用户手动选取的元素，优先级最高
    const customRule = { name: '自定义元素' };
    const custom = getCustomSelectors();
    let customHits = 0;
    for (let i = 0; i < custom.length; i++) {
      const nodes = queryAllDeep(custom[i]);
      for (let j = 0; j < nodes.length; j++) {
        customHits++;
        accept(nodes[j], customRule, elementText(nodes[j]));
      }
    }
    if (custom.length && !customHits && !state.customMissLogged) {
      state.customMissLogged = true;
      state.lastAction = '已记住的元素在本页找不到（可能换页或换了课件）';
      updateStatusLine();
      log('已记住的 ' + custom.length + ' 个元素在本页都没找到；只在出现它们的页面才会点', 'warn');
    }

    // 第一轮：class 直接命中（课件页整图按钮没有文字）
    for (let i = 0; i < BUTTON_RULES.length; i++) {
      const rule = BUTTON_RULES[i];
      if (!rule.selectors || !rule.selectors.length) continue;
      if (!ruleAllowed(rule)) continue;

      for (let j = 0; j < rule.selectors.length; j++) {
        const nodes = queryAllDeep(rule.selectors[j]);
        for (let k = 0; k < nodes.length; k++) accept(nodes[k], rule, elementText(nodes[k]));
      }
    }

    // 第 1.5 轮：按可见文字直搜（对付"没有 btn/next 类名、也不是 a/button"的按钮）
    const textHits = collectTextButtonCandidates();
    for (let i = 0; i < textHits.length; i++) {
      accept(textHits[i].el, textHits[i].rule, textHits[i].text);
    }

    // 第二轮：课程列表卡片
    const cardRule = BUTTON_RULES[BUTTON_RULES.length - 1];
    if (cardRule && cardRule.cardLike) {
      const cards = collectCardCandidates();
      for (let i = 0; i < cards.length; i++) accept(cards[i].el, cardRule, cards[i].text);
    }

    // 第三轮：文案兜底
    const nodes = queryAllDeep(CANDIDATE_SELECTOR);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const text = elementText(el);
      if (!text || text.length > MAX_TEXT_LEN) continue;

      const rule = matchRule(text);
      if (!rule || !ruleAllowed(rule)) continue;

      accept(el, rule, text);
    }

    return dedupeByContain(list);
  }

  function dedupeByContain(list) {
    const result = [];
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      let redundant = false;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const other = list[j];
        if (cur.el.contains(other.el) && other.depth > cur.depth) { redundant = true; break; }
      }
      if (!redundant) result.push(cur);
    }
    return result;
  }

  /**
   * 答题结果页的"返回重选 / 点击继续"：这类按钮和结果文字一起画在图片上
   * （af01.png / at01.png），DOM 里读不到字，只剩一个孤立的 aq 按钮。
   * 特征：整页只有 1 个可点的 aq 类按钮 + 题目识别不到 + 有一张大结果图。
   * 满足时把这个按钮当"继续答题"点掉，避免卡在结果页。
   */
  function findResultContinue() {
    if (findQuiz()) return null;                 // 真有题目时不要误点
    let cands = [];
    try {
      const all = queryAllDeep('[class*="btn-aq"],[class*="aq-btn"],[class*="result-btn"]');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (inPanel(el) || !isVisible(el) || isDisabled(el)) continue;
        if (el.closest && el.closest('[class*="captcha"],[class*="verify"],[class*="tencent"]')) continue;
        const r = el.getClientRects ? el.getClientRects()[0] : null;
        if (!r || r.width < 40 || r.height < 24) continue;
        cands.push(el);
      }
    } catch (e) { return null; }

    // 只留最内层，且必须恰好 1 个才认作结果页按钮（多个那是题目选项）
    const uniq = [];
    for (let i = 0; i < cands.length; i++) {
      let nested = false;
      for (let j = 0; j < cands.length; j++) {
        if (i !== j && cands[j] !== cands[i] && cands[j].contains(cands[i])) { nested = true; break; }
      }
      if (!nested && uniq.indexOf(cands[i]) === -1) uniq.push(cands[i]);
    }
    if (uniq.length !== 1) return null;
    return { el: uniq[0], text: '结果页继续', rule: { name: '继续答题' }, depth: depthOf(uniq[0]) };
  }

  function pickTarget() {
    const list = collectCandidates();
    if (list.length) {
      list.sort(function (a, b) {
        const ra = BUTTON_RULES.indexOf(a.rule);
        const rb = BUTTON_RULES.indexOf(b.rule);
        if (ra !== rb) return ra - rb;
        return b.depth - a.depth;
      });
      return list[0];
    }
    // 结果页的孤立图片按钮（返回重选 / 点击继续）
    const resultBtn = findResultContinue();
    if (resultBtn) return resultBtn;

    // 文字、类名都认不出来时，用几何位置兜底（课件每页类名/配色都不同，只有"位置"是稳定的）
    return findNextByLayout();
  }

  /**
   * 几何识别「下一页」：不看颜色、不看类名，只看布局。
   * 依据：课件翻页几乎总是"底部左右并排的两颗按钮"，右边那颗就是下一页。
   * 依次尝试：① 底部成对按钮取右侧 → ② 右下角带 next 关键词的单个元素。
   */
  /** 页面上是否有「是 / 否」这对按钮（几何识别要避开，否则会把它们当翻页点掉） */
  function hasJudgePair() {
    const nodes = queryAllDeep('button,[role="button"],a,div,span');
    let hits = 0;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;
      const text = elementText(el);
      if (!text || text.length > 3) continue;
      if (!/^(是|否|对|错|正确|错误)$/.test(text)) continue;
      if (el.querySelector && el.querySelector('button,[role="button"]')) continue;
      const rect = el.getClientRects()[0];
      if (!rect || rect.width < 30 || rect.height < 20) continue;
      hits++;
      if (hits >= 2) return true;
    }
    return false;
  }

  function findNextByLayout() {
    if (!CONFIG.geometry.enabled) return null;

    // 课程列表页绝不做几何猜测（底部也有卡片，容易点错）
    if (/^#\/course\/?(\?|$)/.test(location.hash)) return null;

    // 题目页绝不做几何猜测：「是 / 否」两颗按钮正好"底部左右成对"，
    // 会被当成翻页按钮点掉，把答案变成瞎选
    if (hasFormQuiz() || hasJudgePair()) return null;

    // 以前这里要求页面类名里出现 slide/courseware 之类才启用，
    // 结果每套课件的类名都不一样，等于关掉了兜底。现在只排除列表页与题目页。

    const viewWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewWidth || !viewHeight) return null;

    const started = now();
    const cands = [];
    const nodes = document.querySelectorAll('a,button,img,div,span');
    const g = CONFIG.geometry;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;
      const rect = el.getClientRects()[0];
      if (rect.width < g.minWidth || rect.width > g.maxWidth) continue;
      if (rect.height < g.minHeight || rect.height > g.maxHeight) continue;

      const centerY = rect.top + rect.height / 2;
      if (centerY < viewHeight * g.bandRatio) continue; // 只看底部 28%

      const text = elementText(el);
      if (/上一页|返回|退出|上一张|上一步|上一节/.test(text)) continue;
      if (/^(确定|提交|取消|关闭|是|否|对|错|正确|错误)$/.test(text)) continue;

      cands.push({ el: el, rect: rect, text: text });
    }

    if (!cands.length || now() - started > 200) return null;

    let best = null;
    for (let i = 0; i < cands.length; i++) {
      for (let j = 0; j < cands.length; j++) {
        if (i === j) continue;
        const left = cands[i];
        const right = cands[j];

        const leftY = left.rect.top + left.rect.height / 2;
        const rightY = right.rect.top + right.rect.height / 2;
        if (Math.abs(leftY - rightY) > 24) continue; // 必须在同一条水平线上

        const leftX = left.rect.left + left.rect.width / 2;
        const rightX = right.rect.left + right.rect.width / 2;
        if (!(leftX < viewWidth / 2 && rightX > viewWidth / 2)) continue;

        const ratio = left.rect.width / right.rect.width;
        if (ratio < 0.6 || ratio > 1.6) continue; // 两颗按钮尺寸应该接近

        const score = rightY + Math.abs(ratio - 1) * 100; // 越靠下越优先
        if (!best || score > best.score) best = { score: score, el: right.el };
      }
    }

    if (best) {
      return { el: best.el, text: '（位置识别）下一页', rule: { name: '位置识别·成对按钮' } };
    }

    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const centerX = c.rect.left + c.rect.width / 2;
      if (centerX < viewWidth * 0.55) continue;
      const hint = ((typeof c.el.className === 'string' ? c.el.className : '') + ' ' +
        (c.el.getAttribute('src') || '') + ' ' + (c.el.getAttribute('id') || '')).toLowerCase();
      if (/next|right|forward|arrow_r|xia/.test(hint)) {
        return { el: c.el, text: '（位置识别）右下角下一页', rule: { name: '位置识别·右下角' } };
      }
    }

    return null;
  }

  /* ==================================================================
   * 九、模拟点击
   * ================================================================== */
  function simulateClick(el, withTouch) {
    const rect = (el.getClientRects && el.getClientRects()[0]) || { left: 0, top: 0, width: 0, height: 0 };
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    let cx = rect.left + rect.width / 2;
    let cy = rect.top + rect.height / 2;

    // 中心点跑到视口外时，elementFromPoint 会返回 null，事件也"落空"。
    // 之前日志里的"坐标处取不到元素（可能滚出可视区）"就是这种，直接把坐标夹回来
    const vw = view.innerWidth || 0;
    const vh = view.innerHeight || 0;
    if (vw > 0 && vh > 0) {
      cx = Math.min(Math.max(cx, 1), vw - 1);
      cy = Math.min(Math.max(cy, 1), vh - 1);
    }
    const x = Math.round(cx);
    const y = Math.round(cy);
    const base = {
      bubbles: true, cancelable: true, composed: true, view: view,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0
    };

    try { el.focus && el.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }

    // 手机版 H5 课件只监听 touchstart/touchend（不认 click），必要时补上
    if (withTouch && typeof view.TouchEvent === 'function') {
      try { el.dispatchEvent(new view.TouchEvent('touchstart', base)); } catch (e) { /* 忽略 */ }
      try { el.dispatchEvent(new view.TouchEvent('touchend', base)); } catch (e) { /* 忽略 */ }
    }

    if (typeof view.PointerEvent === 'function') {
      try { el.dispatchEvent(new view.PointerEvent('pointerdown', base)); } catch (e) { /* 忽略 */ }
      try { el.dispatchEvent(new view.PointerEvent('pointerup', base)); } catch (e) { /* 忽略 */ }
    }
    try { el.dispatchEvent(new view.MouseEvent('mousedown', base)); } catch (e) { /* 忽略 */ }
    try { el.dispatchEvent(new view.MouseEvent('mouseup', base)); } catch (e) { /* 忽略 */ }

    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new view.MouseEvent('click', base));
  }

  /* ------------------------------------------------------------------
   * 九·二、"点了没反应"的定位与补救
   * 真实世界里点不动只有四种原因，逐一处理：
   *   ① 事件绑在最内层的 span/img 上（点在容器上等于没点）→ 往内层点，事件照样冒泡到外层
   *   ② 按钮被别的浮层盖住（elementFromPoint 拿到的不是它）→ 改点最上层那个元素
   *   ③ 手机版 H5 只听 touch → 补 touchstart/touchend
   *   ④ 网站要开新窗口，被浏览器拦截 → 把"被拦截"打在日志里，而不是默默重试
   * ------------------------------------------------------------------ */


  /**
   * 网站靠 window.open / target=_blank 打开课件的情况：被浏览器拦截时页面毫无变化，
   * 看上去就是"点了没反应"。这里把尝试和被拦截都写进日志，省得以后只能靠猜。
   */
  function hookWindowOpen() {
    if (window.__WB_OPEN_HOOKED__) return;
    window.__WB_OPEN_HOOKED__ = true;

    const original = window.open;
    if (typeof original !== 'function') return;

    window.open = function () {
      const url = String(arguments[0] || '(空地址)').slice(0, 90);
      let win = null;
      try { win = original.apply(window, arguments); } catch (e) { win = null; }

      if (win) {
        log('网站打开了一个新窗口：' + url + '（脚本已在新页面继续生效）');
      } else {
        log('网站想打开新窗口但被浏览器拦截了：' + url +
          '。请点地址栏右侧的「弹窗已拦截」并允许本站弹窗，否则按钮永远点不动', 'error');
      }
      return win;
    };
  }


  /* ==================================================================
   * 十、主循环
   * ================================================================== */
  function isExamPage() {
    if (!CONFIG.guard.pauseOnExamPage) return false;
    if (/exam/i.test(location.pathname + location.hash)) return true;
    return /考试|考核/.test(document.title || '');
  }

  function isVideoPlaying() {
    const video = document.querySelector('video');
    return !!(video && !video.paused && !video.ended);
  }

  /** 顶层是否存在读不到内容的跨域 iframe */
  function hasCrossFrame() {
    try {
      const nodes = document.querySelectorAll('iframe, frame');
      for (let i = 0; i < nodes.length; i++) {
        let ok = false;
        try { ok = !!nodes[i].contentDocument; } catch (e) { ok = false; }
        if (!ok) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /** 一句话说清"看了几个文档、有几个 iframe 读不到"，避免以后只能靠猜 */
  function describeDocs() {
    let docs = 0;
    try { docs = collectDocuments().length; } catch (e) { docs = 1; }

    let frames = 0;
    let cross = 0;
    try {
      const nodes = document.querySelectorAll('iframe, frame');
      frames = nodes.length;
      for (let i = 0; i < nodes.length; i++) {
        let ok = false;
        try { ok = !!nodes[i].contentDocument; } catch (e) { ok = false; }
        if (!ok) cross++;
      }
    } catch (e) { /* 忽略 */ }

    let text = '已扫描 ' + docs + ' 个文档';
    if (frames) text += '、iframe ' + frames + ' 个';
    if (cross) {
      text += '（其中 ' + cross + ' 个跨域，脚本读不到里面的内容）';
      const srcs = [];
      try {
        const nodes = document.querySelectorAll('iframe, frame');
        for (let i = 0; i < nodes.length && srcs.length < 2; i++) {
          let ok = false;
          try { ok = !!nodes[i].contentDocument; } catch (e) { ok = false; }
          if (ok) continue;
          let src = '';
          try { src = nodes[i].src || nodes[i].getAttribute('src') || ''; } catch (e) { src = ''; }
          if (src) srcs.push(src.split('?')[0].slice(0, 60));
        }
      } catch (e) { /* 忽略 */ }
      if (srcs.length) text += '，地址：' + srcs.join(' / ');
    }
    return text;
  }

  /** 页面里到底有没有「下一页」这几个字？有的话把它的尺寸位置报出来，方便判断为什么被过滤 */
  function probeNextButtons() {
    const hits = [];
    const re = /下一页|下一节|下一章|下页|开始学习|继续学习|返回列表|点击确定/;
    let docs = [];
    try { docs = collectDocuments(); } catch (e) { docs = [document]; }

    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d];
      if (!doc || !doc.body) continue;
      let walker = null;
      try {
        const view = doc.defaultView || window;
        const SHOW_TEXT = (view.NodeFilter && view.NodeFilter.SHOW_TEXT) || 4;
        walker = doc.createTreeWalker(doc.body, SHOW_TEXT, null, false);
      } catch (e) { continue; }

      let node = walker.nextNode();
      let guard = 0;
      while (node && guard++ < 6000) {
        const t = normalizeText(node.nodeValue);
        if (t && t.length <= 12 && re.test(t)) {
          const p = node.parentElement;
          if (p) {
            const r = p.getClientRects ? p.getClientRects()[0] : null;
            hits.push(t + (r ? '[' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' : '[无尺寸·不可见]'));
          }
        }
        node = walker.nextNode();
      }
    }
    return hits.length ? (hits.length + ' 处：' + hits.slice(0, 5).join(' / ')) : '页面里没有这类文字';
  }

  function describeIdle() {
    const video = document.querySelector('video');
    if (video && !video.paused && !video.ended) {
      if (isFinite(video.duration) && video.duration > 0) {
        const left = Math.max(0, Math.round(video.duration - video.currentTime));
        return '视频播放中，剩余约 ' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒';
      }
      return '视频播放中，等待播放结束';
    }
    let docCount = 1;
    try { docCount = collectDocuments().length; } catch (e) { docCount = 1; }
    // 这一句是"为什么点了没反应"的关键：说清楚内容到底在哪个帧里
    if (IS_TOP && hasCrossFrame()) {
      if (FRAMES_SEEN.length) {
        return '课件在 iframe 里，帧内脚本已生效（' + FRAMES_SEEN[0].host +
          '）——翻页由那一帧自己完成，面板计数不含帧内点击';
      }
      return '本页内容在跨域 iframe 里，但那一帧的脚本没跑起来（域名判定未通过）；刷新一次页面再试';
    }
    return '本页暂无可点元素（扫描 ' + docCount + ' 个文档），稍后自动重查';
  }

  /* ==================================================================
   * 十·二、安全验证（验证码）：检测 → 停手 → 喊人 → 自动续跑
   * 说明：这里不做自动破解。腾讯点选验证码是平台的反自动化闸门，
   * 脚本硬解既不稳定也会把账号风险拉满；正确做法是停手并让人来点。
   * ================================================================== */
  // 第一档：iframe 型（腾讯/网易验证码本体都是 iframe），可靠
  const CAPTCHA_FRAME_SELECTORS = [
    '#tcaptcha_iframe', 'iframe[src*="captcha"]', 'iframe[src*="turing"]', 'iframe[src*="yidun"]'
  ];

  // 第二档：容器型。学校页面常预渲染一个空的验证码弹层，class 里带 captcha，
  // 平时就在 DOM 里躺着，所以必须"里面真有东西"才算验证码，否则会误判并卡死
  const CAPTCHA_BOX_SELECTORS = [
    '[class*="tcaptcha"]', '[id*="tcaptcha"]', '[class*="yidun"]', '[class*="captcha"]',
    '[class*="verify"]', '[id*="verify"]', '[class*="puzzle"]', '[class*="slide-verify"]'
  ];

  // 课件里实际出现过的是"拖动下方拼图完成验证 / 安全验证"，旧正则只认腾讯那套，
  // 结果验证码已经弹出来了脚本还在照常点题，看着就像"识别不到题目"
  const CAPTCHA_TEXT_RE = /请依次点击|拖动滑块|按住左边滑块|请完成下方验证|拖动[^。]{0,10}拼图|拖动[^。]{0,10}滑块|拼图[^。]{0,6}验证|滑块[^。]{0,6}验证|安全验证|完成验证/;

  /** 页面可见文字，但剔除脚本自己的面板 / 遮罩，避免自我命中 */
  function pageTextWithoutPanel() {
    if (!document.body) return '';
    const parts = [];
    const children = document.body.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.nodeType !== 1) continue;
      if (child.id === 'wb-auto-panel' || child.id === 'wb-pick-overlay' || child.id === 'wb-pick-hover') continue;
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'IFRAME') continue;
      const text = elementText(child);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  // 用户点过「跳过等待」的选择器，本次会话内不再作为验证码依据（刷新页面恢复）
  const captchaSkip = new Set();

  function detectCaptcha() {
    if (!CONFIG.guard.captchaPause) return null;

    const bigEnough = function (el) {
      const rect = el.getClientRects()[0];
      if (!rect || rect.width < 180 || rect.height < 90) return false;
      // 腾讯验证码不用时把整个容器挪到 y=-1000000 藏着，弹出来才回到视口。
      // 课件按钮用的是大画布坐标（几百到一两千都正常），所以这里只在
      // "离谱地远"时才排除，既不误杀课件按钮，也不会把藏起来的验证码当真
      if (rect.top < -5000 || rect.top > 20000) return false;
      if (rect.left < -5000 || rect.left > 20000) return false;
      return true;
    };

    // 1) iframe 型：最可靠，只要求可见且尺寸合理
    for (let i = 0; i < CAPTCHA_FRAME_SELECTORS.length; i++) {
      if (captchaSkip.has(CAPTCHA_FRAME_SELECTORS[i])) continue;
      const nodes = queryAllDeep(CAPTCHA_FRAME_SELECTORS[i]);
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        if (inPanel(el) || !isVisible(el) || !bigEnough(el)) continue;
        return { el: el, selector: CAPTCHA_FRAME_SELECTORS[i] };
      }
    }

    // 2) 容器型：必须能证明"里面真装着验证码"——有 iframe/canvas/img，或带验证码文案
    for (let i = 0; i < CAPTCHA_BOX_SELECTORS.length; i++) {
      if (captchaSkip.has(CAPTCHA_BOX_SELECTORS[i])) continue;
      const nodes = queryAllDeep(CAPTCHA_BOX_SELECTORS[i]);
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        if (inPanel(el) || !isVisible(el) || !bigEnough(el)) continue;

        const hasWidget = !!(el.querySelector('iframe, canvas'));
        const text = elementText(el);
        if (!hasWidget && !CAPTCHA_TEXT_RE.test(text)) continue; // 空壳，跳过

        return { el: el, selector: CAPTCHA_BOX_SELECTORS[i] };
      }
    }

    // 3) 文本兜底：只认验证码专有措辞，且排除面板自身文字
    const body = document.body;
    if (body && !captchaSkip.has('text')) {
      const text = pageTextWithoutPanel();
      // 文案匹配 + 必须有一个"在屏幕附近"的验证码容器。
      // 只有文字、容器却藏在 -1000000 ⇒ 是没弹出的备用 DOM，不算验证码
      if (CAPTCHA_TEXT_RE.test(String(text).slice(0, 200))) {
        let onScreen = false;
        for (let k = 0; k < CAPTCHA_BOX_SELECTORS.length; k++) {
          const nodes = queryAllDeep(CAPTCHA_BOX_SELECTORS[k]);
          for (let m = 0; m < nodes.length; m++) {
            if (inPanel(nodes[m]) || !isVisible(nodes[m])) continue;
            if (bigEnough(nodes[m])) { onScreen = true; break; }
          }
          if (onScreen) break;
        }
        if (onScreen) return { el: null, selector: 'text' };
      }
    }
    return null;
  }

  function beep() {
    if (!CONFIG.guard.alertSound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.07;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(function () {
        try { osc.stop(); } catch (e) { /* 忽略 */ }
        try { if (ctx.close) ctx.close(); } catch (e) { /* 忽略 */ }
      }, 280);
    } catch (e) { /* 没有音频权限就算了 */ }
  }

  let captchaTimer = null;
  let titleTimer = null;
  let titleBackup = '';

  function startTitleFlash() {
    if (!IS_TOP) return;
    titleBackup = document.title;
    if (titleTimer) clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(function () {
      on = !on;
      document.title = on ? '【需完成安全验证】' + titleBackup : titleBackup;
    }, 800);
  }

  function stopTitleFlash() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    if (IS_TOP && titleBackup) document.title = titleBackup;
  }

  function enterCaptchaMode(hit) {
    state.captchaActive = true;
    state.captchaSelector = hit && hit.selector ? hit.selector : 'unknown';
    state.lastAction = '检测到安全验证：请手动完成，完成后自动继续';

    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    state.nextScanAt = 0;

    const via = hit && hit.selector ? '（命中 ' + hit.selector + '）' : '';
    log('检测到安全验证' + via + '，已停手等你完成；通过后会自动接着跑', 'warn');
    if (!IS_TOP) postToTop({ wb: FRAME_MSG, action: 'captcha-on', host: location.hostname });
    startTitleFlash();
    beep();
    updateCaptchaBanner(true);
    updateStatusLine();

    if (captchaTimer) clearInterval(captchaTimer);
    captchaTimer = setInterval(function () {
      if (!state.captchaActive) return;
      if (!detectCaptcha()) exitCaptchaMode();
    }, CONFIG.guard.captchaPollMs);
  }

  function exitCaptchaMode(reason) {
    const wasActive = state.captchaActive;
    state.captchaActive = false;
    if (captchaTimer) { clearInterval(captchaTimer); captchaTimer = null; }
    stopTitleFlash();
    updateCaptchaBanner(false);
    log(reason || '安全验证已完成，恢复自动点击');
    if (wasActive && !IS_TOP) postToTop({ wb: FRAME_MSG, action: 'captcha-off' });
    scheduleScan('验证完成', 900);
  }

  function updateCaptchaBanner(show) {
    if (!panelEl) return;
    const tip = panelEl.querySelector('#wb-captcha-tip');
    if (tip) tip.style.display = show ? 'block' : 'none';
    if (statusEl) {
      statusEl.textContent = show
        ? '已暂停：等待你完成安全验证'
        : (state.running ? '自动点击运行中' : '已暂停');
      statusEl.style.color = show ? '#f08a8a' : (state.running ? '#8fe388' : '#e8c07d');
    }
  }

  /* ------------------------------------------------------------------
   * 看门狗：定时链一旦断（某一轮提前 return 却没安排下一次），
   * 面板会一直显示"运行中"但实际不再扫描 —— 用户看到的就是"突然不动了，重进又好"。
   * 这里每 3 秒体检一次，发现超时就自己把链子接上。
   * ------------------------------------------------------------------ */
  let watchdogTimer = null;

  function watchdogTick() {
    if (!state.running) return;
    if (state.captchaActive || pickerActive || state.answering) return;
    if (clickTimer) return;

    // 扫描本身卡死（异常卡在中间）超过 60 秒：强制释放
    if (state.scanning) {
      if (state.scanStartedAt && now() - state.scanStartedAt > 60000) {
        state.scanning = false;
        log('扫描卡住超过 60 秒，已强制释放并重新开始', 'warn');
        scheduleScan('看门狗', 800);
      }
      return;
    }

    if (!state.nextScanAt) return;
    if (now() < state.nextScanAt + 6000) return;   // 还没到该检查的时间

    log('超过预定时间仍未检查页面，判定定时链中断，已自动重启扫描', 'warn');
    scheduleScan('看门狗', 500);
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(watchdogTick, 3000);
  }

  function scheduleScan(reason, delay) {
    if (scanTimer) clearTimeout(scanTimer);
    // 已暂停：绝不排新的扫描。暂停后各种异步回调（AI、配置同步、可见性等）
    // 仍会调到这里，不加这道闸就会出现"点了暂停还在跑"
    if (!state.running) { state.nextScanAt = 0; return; }

    // 休息时间已过就清标记，面板才会回到"运行中"
    if (state.resting && now() >= state.restUntil) {
      state.resting = false;
      state.restUntil = 0;
    }
    const wait = typeof delay === 'number' ? delay : rand(CONFIG.scan.minInterval, CONFIG.scan.maxInterval);
    state.nextScanAt = now() + wait;
    updateStatusLine();
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan(reason);
    }, wait);
  }

  function scan(trigger) {
    if (!state.running || state.scanning) return;
    if (clickTimer) return;

    // 遇到验证码：立刻停手，先做人该做的事
    if (state.captchaActive) {
      if (!detectCaptcha()) exitCaptchaMode();
      return;
    }
    const captchaHit = detectCaptcha();
    if (captchaHit) {
      enterCaptchaMode(captchaHit);
      return;
    }

    // 选取模式下先别自动点，否则会把脚本自己的点击当成"用户选择"
    if (pickerActive) {
      scheduleScan('选取中', 1500);
      return;
    }

    if (isExamPage()) {
      setRunning(false);
      log('检测到期末考试页，已自动暂停，避免误触「开始考试」；需要时点面板「继续」', 'warn');
      return;
    }

    syncConfigFromStore();

    // 自动看：视频正在播放时先别点任何按钮，等它播完再翻页
    if (isVideoPlaying()) {
      state.lastAction = describeIdle();
      updateStatusLine();
      scheduleScan('视频播放中', rand(CONFIG.scan.minInterval, CONFIG.scan.maxInterval));
      return;
    }

    state.scanning = true;
    state.scanStartedAt = now();
    state.lastScanAt = now();
    state.idleFast = false;

    try {
      const target = pickTarget();
      if (target) {
        // 关键（补上 v1.5.0 做不了题的那一半原因）：
        // 答题页上常常同时挂着"下一页/继续学习"按钮，若先点了它，
        // 本轮就直接 return、永远轮不到 answerQuiz —— 表现就是"翻页很稳但从不答题"。
        // 所以只要识别出题目，先把题答了，再让它按老节奏翻页。
        if (CONFIG.quiz.enabled && findQuiz()) {
          const handled = answerQuiz();
          if (handled) return;
        }
        state.zeroScans = 0;
        pendingClick(target);
        return;
      }

      state.zeroScans++;
      // 一个可点元素都没有时改走快查：DOM 查询只是本地读页面，不发请求、不触发风控
      state.idleFast = !isVideoPlaying();

      const frameAlive = IS_TOP && hasCrossFrame() && FRAMES_SEEN.length > 0;
      if (frameAlive) {
        // 内容在课件帧里、帧内脚本也活着：顶层空转是完全正常的，不该反复告警
        if (state.zeroScans === 3) {
          log('顶层没有可点元素，但课件帧（' + FRAMES_SEEN[0].host +
            '）里的脚本在正常工作，由它负责翻页 —— 这条只是说明情况，不用处理');
        }
      } else if (state.zeroScans === 3 || (state.zeroScans > 0 && state.zeroScans % 20 === 0)) {
        log('连续 ' + state.zeroScans + ' 次未识别到可点元素。' + describeDocs() +
          '；页面内相关文字：' + probeNextButtons(), 'warn');
        if (hasCrossFrame() && IS_TOP) {
          log('课件内容在跨域 iframe 里：脚本必须进到那个帧才能点到。' +
            (FRAMES_SEEN.length
              ? '目前帧内脚本已生效（' + FRAMES_SEEN.map(function (f) { return f.host; }).join('、') +
                '），说明翻页由那一帧负责，顶层这里没事可做'
              : '目前那一帧里的脚本没跑起来（域名判定没过）。刷新一次页面；仍不行就点「扫描诊断」把报告发我'), 'warn');
        }
      }

      state.lastAction = describeIdle();
      updateStatusLine();

      let handled = false;
      if (CONFIG.quiz.enabled) handled = answerQuiz();

      if (!handled) {
        // 页面明显像答题页，但一条识别路径都没命中：说清"看到了什么"，别让人干等
        if (CONFIG.quiz.enabled && !state.quizMissLogged && looksLikeQuizPage() && !findQuiz()) {
          state.quizMissLogged = true;
          state.lastAction = '页面像答题页，但没认出选项，请点「扫描诊断」';
          log('页面像答题页（检测到"多选/请选择/哪些"等字样），但没找到可选项；' +
            '请点「扫描诊断」把报告发我，我按真实结构适配', 'warn');
          updateStatusLine();
        }

        // 有题目但没开 AI 答题时，明确告诉用户下一步该点哪里，而不是干等
        if (!CONFIG.quiz.enabled && !state.quizHintShown && findQuiz()) {
          state.quizHintShown = true;
          state.lastAction = '检测到题目：去「AI 设置」勾选自动答题';
          log('检测到题目，但未启用 AI 答题，请在「AI 设置」里勾选后保存', 'warn');
          updateStatusLine();
        }
        if (CONFIG.interactive.enabled) tickInteractive();

        // 实在找不到任何可点元素：让 AI 看着课件画面判断点哪里（你的 API 用在刀刃上）
        maybeAiFindClick();
      }
    } catch (err) {
      log('检查页面时出错：' + (err && err.message ? err.message : err), 'error');
    } finally {
      state.scanning = false;
      if (!clickTimer) {
        // 空页时查得勤一点（纯本地 DOM 查询，不发请求、不触发风控）；
        // 但不再因为"点不动"切到另一套频率，避免节奏忽快忽慢
        if (state.idleFast) {
          scheduleScan(trigger || '空页快查', rand(CONFIG.scan.idleMinInterval, CONFIG.scan.idleMaxInterval));
        } else {
          scheduleScan(trigger || '定时');
        }
      }
    }
  }

  /** 记一次点击；到点就进入长休息。返回 true 表示已经在休息了 */
  function maybeRest() {
    state.sinceRest++;
    if (CONFIG.guard.restEvery > 0 && state.sinceRest >= CONFIG.guard.restEvery) {
      state.sinceRest = 0;
      const restMs = rand(CONFIG.guard.restMinMs, CONFIG.guard.restMaxMs);
      state.resting = true;
      state.restUntil = now() + restMs;
      log('已连续点击 ' + CONFIG.guard.restEvery + ' 次，停顿 ' +
        Math.round(restMs / 1000) + ' 秒后自动继续（刻意设计的节奏，不是卡住）', 'warn');
      scheduleScan('长休息', restMs);
      return true;
    }
    return false;
  }

  function pendingClick(target) {
    // v1.5.0 的稳定翻页逻辑：延迟→点击→计数→排下一次。
    // 不再做"点完有没有效果"的自检、拉黑、换策略 —— 那些判断在课件上经常误判，
    // 反而把本来稳定的翻页搞卡。答题靠的是 answerQuiz，跟翻页这条链完全解耦。
    const delay = rand(CONFIG.click.minDelay, CONFIG.click.maxDelay);
    state.lastAction = '发现「' + target.text + '」，' + (delay / 1000).toFixed(1) + ' 秒后点击';
    updateStatusLine();
    log('命中「' + target.text + '」(' + target.rule.name + ')，延迟 ' + delay + 'ms 后点击');

    clickTimer = setTimeout(function () {
      clickTimer = null;
      if (!state.running) return;

      if (!target.el.isConnected || !isVisible(target.el) || isDisabled(target.el)) {
        log('目标按钮已消失或不可点，放弃本次点击', 'warn');
        scheduleScan('按钮失效');
        return;
      }

      try {
        // 和 v1.5.0 一致：直接点解析出来的那个按钮
        simulateClick(resolveClickTarget(target.el));
        clickedAtMap.set(target.el, now());
        state.clickCount++;
        state.pageClicks++;
        state.lastAction = '已点击「' + target.text + '」';
        log('已点击「' + target.text + '」，累计 ' + state.clickCount + ' 次');
        updateStatusLine();
        if (!IS_TOP) {
          postToTop({ wb: FRAME_MSG, action: 'progress', text: target.text, clicks: state.clickCount });
        }
      } catch (err) {
        log('点击失败：' + (err && err.message ? err.message : err), 'error');
      }

      if (state.pageClicks > CONFIG.guard.maxClicksPerPage) {
        setRunning(false);
        log('本页点击已超过 ' + CONFIG.guard.maxClicksPerPage + ' 次，自动暂停，请人工检查页面', 'warn');
        return;
      }

      // 保留用户要的节奏：每 8 次停 2-8 秒，面板写明"停顿，不是卡住"
      state.sinceRest++;
      if (CONFIG.guard.restEvery > 0 && state.sinceRest >= CONFIG.guard.restEvery) {
        state.sinceRest = 0;
        const restMs = rand(CONFIG.guard.restMinMs, CONFIG.guard.restMaxMs);
        state.resting = true;
        state.restUntil = now() + restMs;
        log('已连续点击 ' + CONFIG.guard.restEvery + ' 次，停顿 ' +
          Math.round(restMs / 1000) + ' 秒后自动继续（刻意设计的节奏，不是卡住）', 'warn');
        scheduleScan('长休息', restMs);
        return;
      }

      scheduleScan('点击后', rand(CONFIG.click.postClickPause * 0.9, CONFIG.click.postClickPause * 1.3));
    }, delay);
  }

  /**
   * 真正把"运行/暂停"落到本窗口。fromMessage=true 表示这是别的窗口同步过来的，
   * 只应用、不再往回广播（否则顶层和帧之间会无限互发消息）。
   */
  function applyRunning(next, fromMessage) {
    const was = state.running;
    state.running = !!next;

    if (state.running) {
      if (!fromMessage) {
        // 用户点「继续」：清空退避，立即重来
        if (!IS_TOP) postToTop({ wb: FRAME_MSG, action: 'reset-backoff' });
        else postToFrames({ wb: FRAME_MSG, action: 'reset-backoff' });
        log('已恢复运行（退避与跳过记录已清空，立即重试）');
      }
      scheduleScan('手动恢复', 500);
    } else {
      log(was ? '已暂停' : '仍为暂停');
      state.scanning = false;
      state.answering = false;
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (observeTimer) { clearTimeout(observeTimer); observeTimer = null; }
      state.nextScanAt = 0;
    }
    updatePanelState();
    updateStatusLine();

    // 关键：暂停/继续要同步到课件帧（真正干活的是那一帧），否则顶层暂停了帧还在点
    if (!fromMessage && was !== state.running) {
      const msg = { wb: FRAME_MSG, action: 'running', value: state.running };
      if (IS_TOP) postToFrames(msg);
      else postToTop(msg);
    }
  }

  function setRunning(next) {
    // 用户主动点「跳过等待」：把当前命中的选择器一起拉黑，否则下一轮又卡回去
    if (state.running && state.captchaActive) {
      let muted = 0;
      const allSelectors = CAPTCHA_FRAME_SELECTORS.concat(CAPTCHA_BOX_SELECTORS);
      for (let i = 0; i < allSelectors.length; i++) {
        const sel = allSelectors[i];
        const hit = queryAllDeep(sel).some(function (el) {
          return !inPanel(el) && isVisible(el);
        });
        if (hit) { captchaSkip.add(sel); muted++; }
      }
      captchaSkip.add('text');

      state.captchaActive = false;
      if (captchaTimer) { clearInterval(captchaTimer); captchaTimer = null; }
      stopTitleFlash();
      updateCaptchaBanner(false);
      log('已跳过验证等待，本次会话不再据此暂停（共忽略 ' + muted + ' 类元素；刷新页面可恢复检测）', 'warn');
      postToFrames({ wb: FRAME_MSG, action: 'captcha-skip' });
    }
    applyRunning(next, false);
  }

  /* ==================================================================
   * 十一、路由与 DOM 变化监听
   * ================================================================== */
  function onRouteChange(source) {
    if (location.href === state.route) return;
    state.route = location.href;
    state.pageClicks = 0;
    state.quizHintShown = false;
    state.quizMissLogged = false;
    state.customMissLogged = false;
    // 换页了，"这个按钮点不动"的判断要作废，否则新页面的同名按钮会被误跳过
    resetGameAgent();
    state.lastAction = '页面已跳转，重新检查（' + source + '）';
    log('检测到页面跳转：' + location.pathname + location.hash);
    updateStatusLine();
    broadcastActivate();
    setTimeout(broadcastActivate, 1500);
    if (state.running) scheduleScan('路由变化', rand(800, 1500));
  }

  function hookHistory() {
    ['pushState', 'replaceState'].forEach(function (name) {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        const ret = original.apply(this, arguments);
        try { onRouteChange(name); } catch (e) { /* 忽略 */ }
        return ret;
      };
    });
    window.addEventListener('popstate', function () { onRouteChange('popstate'); });
    window.addEventListener('hashchange', function () { onRouteChange('hashchange'); });
  }

  function observeDom() {
    if (!window.MutationObserver || !document.body) return;

    const observer = new MutationObserver(function (records) {
      // 只统计"页面自己"的变动：面板刷倒计时不算，否则页面上永远"有变化"
      let ownPanelOnly = true;
      for (let i = 0; i < records.length; i++) {
        const t = records[i].target;
        if (!(t && t.closest && t.closest('#wb-auto-panel'))) { ownPanelOnly = false; break; }
      }
      if (!ownPanelOnly) mutationTick++;

      if (!state.running || clickTimer || pickerActive) return;

      // 面板自己每 0.5 秒都在改文字（倒计时），不排除掉的话会变成"自己触发自己"，
      // 把 15-30 秒的轮询节奏冲成每 2 秒一次，既容易招风控，也让日志失真
      let onlyOwnPanel = true;
      for (let i = 0; i < records.length; i++) {
        const t = records[i].target;
        if (!(t && t.closest && t.closest('#wb-auto-panel'))) { onlyOwnPanel = false; break; }
      }
      if (onlyOwnPanel) return;

      if (observeTimer) clearTimeout(observeTimer);

      observeTimer = setTimeout(function () {
        observeTimer = null;
        if (!state.running || clickTimer || pickerActive) return;
        if (now() - state.lastScanAt < CONFIG.observe.minGap) return;
        scheduleScan('DOM 变化', rand(200, 600));
      }, CONFIG.observe.debounce);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ==================================================================
   * 十二、DeepSeek 调用
   * ================================================================== */
  function getKey() {
    return String(Store.get('deepseek_key', '') || '').trim();
  }

  function callDeepSeekRaw(key, messages, options) {
    const opt = options || {};
    const body = {
      model: opt.model || CONFIG.quiz.model,
      temperature: typeof opt.temperature === 'number' ? opt.temperature : CONFIG.quiz.temperature,
      stream: false,
      messages: messages
    };
    if (opt.jsonMode) body.response_format = { type: 'json_object' };
    if (opt.maxTokens) body.max_tokens = opt.maxTokens;
    const payload = JSON.stringify(body);

    return new Promise(function (resolve) {
      const fail = function (message) {
        resolve({ ok: false, status: 0, content: null, message: message });
      };

      const parseResponse = function (status, text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data) return fail('返回不是 JSON（HTTP ' + status + '）');
        if (data.error) return fail((data.error.message || '接口返回错误') + '（HTTP ' + status + '）');

        const content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        if (!content) return fail('接口返回为空（HTTP ' + status + '）');
        resolve({ ok: true, status: status, content: String(content), message: 'ok' });
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: CONFIG.quiz.endpoint,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          data: payload,
          timeout: CONFIG.quiz.timeout,
          onload: function (res) { parseResponse(res.status || 0, res.responseText || ''); },
          onerror: function () { fail('网络或鉴权失败（浏览器没拿到响应）'); },
          ontimeout: function () { fail('请求超时（' + Math.round(CONFIG.quiz.timeout / 1000) + 's）'); }
        });
        return;
      }

      if (typeof fetch !== 'function') {
        fail('当前环境既没有 GM_xmlhttpRequest 也没有 fetch');
        return;
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (controller) controller.abort();
        fail('请求超时（' + Math.round(CONFIG.quiz.timeout / 1000) + 's）');
      }, CONFIG.quiz.timeout);

      try {
        fetch(CONFIG.quiz.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: payload,
          signal: controller ? controller.signal : undefined
        }).then(function (resp) {
          return resp.text().then(function (text) { return { status: resp.status, text: text }; });
        }).then(function (res) {
          clearTimeout(timer);
          parseResponse(res.status, res.text);
        }).catch(function (err) {
          clearTimeout(timer);
          fail('请求异常：' + (err && err.message ? err.message : err));
        });
      } catch (err) {
        clearTimeout(timer);
        fail('请求无法发出（可能被页面策略拦截）：' + (err && err.message ? err.message : err));
      }
    });
  }

  function callDeepSeek(key, messages, options) {
    return callDeepSeekRaw(key, messages, options).then(function (res) {
      if (!res.ok) {
        log('DeepSeek 请求失败：' + res.message, 'warn');
        return null;
      }
      return res.content;
    });
  }

  /* ==================================================================
   * 十三、选择题
   * ================================================================== */
  const OPTION_LETTER_RE = /^([A-Da-d])(?:[\.、．:：\)）]|\s)\s*(\S.*)$/;

  function queryVisible(selectorList) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < selectorList.length; i++) {
      const nodes = queryAllDeep(selectorList[i]);
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        if (seen.has(el) || inPanel(el) || !isVisible(el)) continue;
        const text = elementText(el);
        if (!text) continue;
        seen.add(el);
        out.push({ el: el, text: text });
      }
    }
    return out;
  }

  function labelOfInput(input) {
    const id = input.getAttribute ? input.getAttribute('id') : '';
    const doc = input.ownerDocument || document;
    if (id) {
      try {
        const escaped = (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(id) : id;
        const byFor = doc.querySelector('label[for="' + escaped + '"]');
        if (byFor) return byFor;
      } catch (e) { /* 忽略 */ }
    }
    const wrap = input.closest ? input.closest('label') : null;
    return wrap || input.parentElement;
  }

  /** 没有输入框可锚定时，取页面上"最短的、带问号的"可见文本块当题干 */
  /** 页面上有没有"像题目"的字样（只用于给提示，不用于判定） */
  function looksLikeQuizPage() {
    const text = elementText(document.body);
    return /多选题|单选题|判断题|不定项|请选择|以下哪|哪些|答题/.test(text);
  }

  function guessStemFromPage() {
    const nodes = document.querySelectorAll('h1,h2,h3,h4,p,div,span');
    let best = null;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;
      if (el.querySelector('input,button')) continue;
      const text = elementText(el);
      if (!text || text.length < 8 || text.length > 300) continue;
      // 以前只认带问号的句子，但很多题目写成"……有哪些关于文化发展的要求？"之外的句式
      // （或者把问号做成图片），所以放宽：带疑问词/题干特征词也算
      const hasMark = /[?？]/.test(text);
      const hasWord = /(哪些|什么|如何|是否|要求|说法|正确的是|错误的是|属于|包括|应当|下列)/.test(text);
      if (!hasMark && !hasWord) continue;
      // 带问号的优先；同样带问号时取最短的（避免把整段正文当题干）
      const score = (hasMark ? 0 : 1000) + text.length;
      if (!best || score < best.score) best = { el: el, text: text, score: score };
    }
    return best;
  }

  /** 猜测题干：取输入框之前、最像题目的那段可见文本 */
  function guessStem(firstInput) {
    const scope = (firstInput.closest && firstInput.closest(
      '[class*="question"],[class*="quiz"],[class*="exam"],[class*="knowledge"],form'
    )) || document.body;

    const nodes = scope.querySelectorAll('h1,h2,h3,h4,p,div,span,li');
    let fallback = '';

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.contains(firstInput)) continue;
      if (el.querySelector('input')) continue;      // 选项行，不是题干
      if (!isVisible(el)) continue;

      const text = elementText(el);
      if (!text || text.length < 6 || text.length > 300) continue;

      // 必须出现在第一个输入框之前（2 = DOCUMENT_POSITION_PRECEDING）
      if (!(firstInput.compareDocumentPosition(el) & 2)) continue;

      if (/[?？]/.test(text) || /(哪些|什么|哪项|哪种|正确|错误|属于|主要|应该)/.test(text)) {
        return { el: el, text: text };
      }
      if (!fallback) fallback = text;
    }

    return fallback ? { el: null, text: fallback } : null;
  }

  /** 选项文字：勾选框旁边的文案，可能在同一行容器里 */
  function optionTextFor(input) {
    const holder = labelOfInput(input) || input.parentElement;
    if (!holder) return '';
    let text = elementText(holder);
    if (!text && holder.parentElement) text = elementText(holder.parentElement);
    return text.replace(/^[A-Fa-f][\.、．\)）]\s*/, '').trim();
  }

  /** 提交按钮：微伴这类页面写的是「点击确定」 */
  function findSubmitButton() {
    const nodes = queryAllDeep('button,[role="button"],a,div,span');
    let best = null;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;
      if (el.querySelector && el.querySelector('[class*="btn"],[role="button"]')) continue;

      const text = elementText(el);
      if (!text || text.length > 8) continue;
      if (!/确定|提交|完成|下一题|继续/.test(text)) continue;
      if (/取消|关闭|退出|返回/.test(text)) continue;

      if (!best || text.length < best.text.length) best = { el: el, text: text };
    }
    return best;
  }

  /**
   * 表单型题目（微伴「知识问答」的真实结构）：
   * 题干是普通 div，选项是 input[type=checkbox/radio] + 旁边文案，按钮叫「点击确定」。
   * 特征最硬的是"两个以上可见勾选框"，据此反推题干与选项，不依赖任何类名。
   */
  function findFormQuiz() {
    const inputs = queryAllDeep('input[type="radio"], input[type="checkbox"]').filter(function (input) {
      if (!input.isConnected || inPanel(input)) return false;
      const holder = labelOfInput(input) || input.parentElement;
      return !!holder && isVisible(holder);
    });
    if (inputs.length < 2) return null;

    const first = inputs[0];
    const group = inputs.filter(function (input) {
      if (first.name && input.name) return input.name === first.name;
      return true;
    }).slice(0, 6);
    if (group.length < 2) return null;

    const stem = guessStem(first);
    if (!stem) return null;

    const options = [];
    const seen = {};
    const letters = 'ABCDEF';
    for (let i = 0; i < group.length; i++) {
      const input = group[i];
      const text = optionTextFor(input);
      if (!text || text.length > 120 || seen[text]) continue;
      seen[text] = true;
      options.push({
        el: labelOfInput(input) || input.parentElement,
        input: input,
        text: text,
        letter: letters.charAt(options.length)
      });
    }
    if (options.length < 2) return null;

    return { stem: stem.text, stemEl: stem.el, options: options, submit: findSubmitButton(), kind: 'form' };
  }

  /** 文本型题目：选项自带 "A." 前缀的老式结构 */
  function findTextQuiz() {
    let stem = null;
    const stems = queryVisible(QUIZ_SELECTORS.stem).filter(function (item) {
      return item.text.length >= 4 && item.text.length <= 400;
    });
    if (stems.length) {
      stems.sort(function (a, b) { return b.text.length - a.text.length; });
      stem = stems[0];
    }
    if (!stem) stem = guessStemFromPage();
    if (!stem) return null;

    const rawOptions = queryVisible(QUIZ_SELECTORS.option);
    const parsed = [];
    for (let i = 0; i < rawOptions.length; i++) {
      const text = rawOptions[i].text;
      if (text.length > 120) continue;
      const m = text.match(OPTION_LETTER_RE);
      if (!m) continue;
      parsed.push({ el: rawOptions[i].el, text: text, letter: m[1].toUpperCase() });
    }

    const options = [];
    const usedLetters = {};
    for (let i = 0; i < parsed.length; i++) {
      const cur = parsed[i];
      let containsOther = false;
      for (let j = 0; j < parsed.length; j++) {
        if (i === j) continue;
        if (cur.el !== parsed[j].el && cur.el.contains(parsed[j].el)) { containsOther = true; break; }
      }
      if (containsOther || usedLetters[cur.letter]) continue;
      usedLetters[cur.letter] = true;
      options.push(cur);
    }
    if (options.length < 2) return null;

    return { stem: stem.text, stemEl: stem.el, options: options, submit: findSubmitButton(), kind: 'text' };
  }

  // "A制定《国家安全法》是…" 这种字母与正文直接相连、没有点号、没有空格的写法
  const PREFIX_OPTION_RE = /^([A-Ha-h])\s*[.、．:：)）]?\s*([\u4e00-\u9fa5][\s\S]{2,})$/;

  /**
   * 纯文字的选项识别：只看"这块文字是不是以 A/B/C 开头"，不看类名、不看结构、不看颜色。
   * 这是最后一道兜底 —— 前面的规则都要求有方块/input/独立标签，
   * 而实体课件里常常就是几个普通 div，字母直接粘在正文上。
   * 为了不误伤正文，要求：从 A 起连续、纵向排列、左边缘基本对齐。
   */
  function findPrefixRowQuiz() {
    const nodes = queryAllDeep('div,p,li,span,a,section,td,h4,h5,h6');
    const cands = [];

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;

      const text = elementText(el);
      if (!text || text.length < 4 || text.length > 200) continue;

      const m = text.match(PREFIX_OPTION_RE);
      if (!m) continue;

      const rect = el.getClientRects ? el.getClientRects()[0] : null;
      if (!rect || rect.width < 80 || rect.height < 16 || rect.height > 260) continue;

      cands.push({
        letter: m[1].toUpperCase(),
        text: text.replace(PREFIX_OPTION_RE, '$2').trim(),
        el: el,
        rect: rect,
        area: rect.width * rect.height
      });
    }
    if (cands.length < 2) return null;

    // 同一字母只留"最具体"的那一层（面积最小），否则父容器会把整组选项吞成一个
    const byLetter = {};
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (!byLetter[c.letter] || c.area < byLetter[c.letter].area) byLetter[c.letter] = c;
    }

    const picked = Object.keys(byLetter).sort().map(function (k) { return byLetter[k]; });
    if (picked.length < 2) return null;

    // 必须从 A 开始、连续，且纵向排列（横向那种多半是导航栏或正文里的项目符号）
    if (picked[0].letter !== 'A') return null;
    picked.sort(function (a, b) { return a.rect.top - b.rect.top; });

    const rows = [picked[0]];
    for (let i = 1; i < picked.length; i++) {
      const prev = rows[rows.length - 1];
      const cur = picked[i];
      if (cur.letter.charCodeAt(0) !== prev.letter.charCodeAt(0) + 1) continue;
      if (cur.rect.top - prev.rect.top < 8) continue;                       // 必须在不同行
      if (Math.abs(cur.rect.left - prev.rect.left) > 80) continue;          // 左边缘要对齐
      rows.push(cur);
    }
    if (rows.length < 2) return null;

    let stem = null;
    try { stem = guessStemFromPage(); } catch (e) { stem = null; }

    const options = rows.map(function (r) {
      const square = findOptionSquare(r.el);
      return {
        el: square || r.el,
        contentEl: r.el,
        square: square,
        row: r.el,
        text: r.text,
        letter: r.letter
      };
    });

    return {
      stem: stem ? stem.text : '',
      stemEl: stem ? stem.el : null,
      options: options,
      submit: findSubmitButton(),
      kind: 'prefix'
    };
  }

  // 是非题：选项就是两个按钮（是/否、对/错、正确/错误）
  const JUDGE_OPTION_RE = /^(是|否|对|错|正确|错误|是的|不是)$/;

  function findJudgeQuiz() {
    const nodes = queryAllDeep('button,[role="button"],a,div,span,li');
    const raw = [];

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;

      const text = elementText(el);
      if (!text || text.length > 3) continue;
      if (!JUDGE_OPTION_RE.test(text)) continue;

      const rect = el.getClientRects()[0];
      if (!rect || rect.width < 30 || rect.height < 20) continue;   // 太小的是图例/角标
      if (el.querySelector('button,[role="button"]')) continue;      // 容器不算

      raw.push({ el: el, text: text });
    }

    // 父子同时命中时只留内层
    const options = [];
    for (let i = 0; i < raw.length; i++) {
      let nested = false;
      for (let j = 0; j < raw.length; j++) {
        if (i === j) continue;
        if (raw[i].el.contains(raw[j].el)) { nested = true; break; }
      }
      if (!nested) options.push(raw[i]);
    }
    if (options.length !== 2) return null;                          // 是非题就该只有两个选项

    const stem = guessStemFromPage();
    if (!stem) return null;

    return {
      stem: stem.text,
      stemEl: stem.el,
      options: options.map(function (o, idx) {
        return { el: o.el, text: o.text, letter: idx === 0 ? 'A' : 'B' };
      }),
      submit: findSubmitButton(),
      kind: 'judge'
    };
  }

  /* ------------------------------------------------------------------
   * 第四条识别路径：字母行式选项（截图里的「A 太空 / B 网络空间 + 小方块」）
   * 特征：字母是单独的元素，选项文字也是单独的元素，勾选是自绘方块，DOM 里没有 input
   * ------------------------------------------------------------------ */
  // 选项标签的常见写法："A"、"A."、"A、"、"选项A"、"选项 A"、"(A)"、"（A）"
  // 真实课件里最常见的是「选项A」，只认单个字母会整组漏掉
  const OPTION_LABEL_RE = /^(?:选\s*项\s*)?[（(]?([A-Ha-h])[)）]?\s*[.、．:：]?$/;

  function matchOptionLabel(text) {
    const m = String(text || '').trim().match(OPTION_LABEL_RE);
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * 去掉行首的选项前缀，留下真正的选项内容。需要兼容这几种写法：
   *   "选项A 太空" / "选项 A 太空" / "A. 太空" / "A、太空" / "(A) 太空" / "A 太空"
   */
  function stripOptionLabel(text) {
    let out = String(text || '').trim();

    // 1) 「选项A」前缀
    out = out.replace(/^选\s*项\s*[（(]?[A-Ha-h][)）]?\s*[.、．:：]?\s*/, '');

    // 2) 「(A)」括起来的标签
    out = out.replace(/^[（(]\s*[A-Ha-h]\s*[)）]\s*[.、．:：]?\s*/, '');

    // 3) 「A.」「A、」「A：」这类带标点的
    out = out.replace(/^[A-Ha-h]\s*[.、．:：]\s*/, '');

    // 4) 只剩「A 」这种字母加空格的
    out = out.replace(/^[A-Ha-h]\s+/, '');

    return out.trim();
  }

  /** 行内那个小方块（自绘勾选框）：接近正方形、没有文字的小元素 */
  function findOptionSquare(row) {
    let best = null;
    const kids = row.querySelectorAll('*');
    for (let i = 0; i < kids.length && i < 40; i++) {
      const el = kids[i];
      if (elementText(el)) continue;
      const rect = el.getClientRects ? el.getClientRects()[0] : null;
      if (!rect) continue;
      if (rect.width < 10 || rect.width > 46) continue;
      if (rect.height < 10 || rect.height > 46) continue;
      if (Math.abs(rect.width - rect.height) > 8) continue;
      best = el;
    }
    return best;
  }

  /**
   * 行内真正可点的"内容块"：面积最大、并且带文字的子元素（真实页面里是那块深色按钮）。
   * 找不到足够大的就用整行。
   */
  function pickRowContent(row, labelEl) {
    const kids = row.querySelectorAll('*');
    let best = null;
    let bestArea = 0;

    for (let i = 0; i < kids.length && i < 40; i++) {
      const el = kids[i];
      if (el === labelEl) continue;
      if (labelEl && labelEl.contains(el)) continue;
      const text = elementText(el);
      if (!text) continue;
      const r = el.getClientRects ? el.getClientRects()[0] : null;
      if (!r || r.height > 130) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }

    const rowRect = row.getClientRects ? row.getClientRects()[0] : null;
    if (best && rowRect && bestArea >= rowRect.width * rowRect.height * 0.45) return best;
    return null;
  }

  function findLetterRowQuiz() {
    const nodes = queryAllDeep('div,span,li,p,label,i,em,b,td');
    const letters = [];

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (inPanel(el) || !isVisible(el)) continue;
      if (el.children && el.children.length) continue;      // 只认纯文字的标签
      const text = elementText(el);
      if (!text || text.length > 8) continue;
      const letter = matchOptionLabel(text);
      if (!letter) continue;

      const rect = el.getClientRects()[0];
      if (!rect || rect.width > 120 || rect.height > 80) continue;
      letters.push({ el: el, letter: letter });
    }
    if (letters.length < 2) return null;

    // 字母元素本身常常没有独立定位（靠 flex 排版），所以不能用它的坐标排序；
    // 先向上找到"行容器"，用行的坐标来排序和去重。
    const rows = [];
    for (let i = 0; i < letters.length; i++) {
      let row = letters[i].el.parentElement;
      let pick = null;
      for (let d = 0; d < 3 && row; d++) {
        const r = row.getClientRects ? row.getClientRects()[0] : null;
        const t = elementText(row);
        if (r && r.height >= 18 && r.height <= 140 && t.length > 1 && t.length <= 120) {
          pick = { el: row, rect: r };
          break;
        }
        row = row.parentElement;
      }
      if (!pick) continue;
      rows.push({ letter: letters[i].letter, rowEl: pick.el, letterEl: letters[i].el, rect: pick.rect });
    }
    if (rows.length < 2) return null;

    rows.sort(function (a, b) { return a.rect.top - b.rect.top; });

    const options = [];
    const usedLetters = {};
    const usedRows = [];
    let leftRef = null;

    for (let i = 0; i < rows.length; i++) {
      const cur = rows[i];
      if (usedLetters[cur.letter]) continue;
      if (usedRows.indexOf(cur.rowEl) !== -1) continue;      // 同一行只算一次

      const optionText = stripOptionLabel(elementText(cur.rowEl));
      if (!optionText) continue;

      // 选项应该左对齐，否则大概不是一组选项
      if (leftRef === null) leftRef = cur.rect.left;
      else if (Math.abs(cur.rect.left - leftRef) > 40) continue;

      usedLetters[cur.letter] = true;
      usedRows.push(cur.rowEl);
      const square = findOptionSquare(cur.rowEl);
      const contentEl = pickRowContent(cur.rowEl, cur.letterEl);
      options.push({
        // 优先点"内容块"（真实页面里那块深色按钮才是绑事件的地方），
        // 其次字母标签，最后整行；三个都留着，点击失败时会自动换下一个
        el: contentEl || cur.letterEl || square || cur.rowEl,
        contentEl: contentEl,
        letterEl: cur.letterEl,
        square: square,
        row: cur.rowEl,
        text: optionText,
        letter: cur.letter
      });
    }

    if (options.length < 2) return null;

    const stem = guessStemFromPage();
    if (!stem) return null;

    // 必须找到提交按钮，否则选了也交不上去，就不要瞎点
    const submit = findSubmitButton();
    if (!submit) return null;

    const pageText = elementText(document.body);
    let typeHint = '';
    if (/多选题|不定项|多选/.test(pageText)) typeHint = '多选题，正确答案可能不止一个';
    else if (/单选题|单选/.test(pageText)) typeHint = '单选题，只有一个正确答案';
    else if (/判断题/.test(pageText)) typeHint = '判断题';

    return {
      stem: stem.text,
      stemEl: stem.el,
      options: options,
      submit: submit,
      kind: 'letter',
      typeHint: typeHint
    };
  }

  /* ------------------------------------------------------------------
   * 第五条识别路径：字母和文字在同一行（截图里的「A 社会安全是国家安全的…＋右侧方块」）
   * 这种结构没有独立的字母元素，只能按"以字母开头的短句"去找行；
   * 为了避免误伤正文里以 A 开头的英文单词，要求字母后面必须跟中文。
   * ------------------------------------------------------------------ */
  const INLINE_OPTION_RE = /^[（(]?([A-Ha-h])[)）]?\s*[.、．:：]?\s*(\S[\s\S]*)$/;

  function findInlineLetterQuiz() {
    const roots = collectRoots();
    const options = [];
    const usedLetters = {};
    const usedRows = [];

    for (let d = 0; d < roots.length; d++) {
      const root = roots[d];
      if (!root) continue;

      const isDoc = root.nodeType === 9;
      const ownerDoc = isDoc ? root : (root.ownerDocument || document);
      const host = isDoc ? root.body : root;
      if (!host) continue;

      let walker = null;
      try {
        const view = ownerDoc.defaultView || window;
        const SHOW_TEXT = (view.NodeFilter && view.NodeFilter.SHOW_TEXT) || 4;
        walker = ownerDoc.createTreeWalker(host, SHOW_TEXT, null, false);
      } catch (e) { continue; }

      let node = walker.nextNode();
      let guard = 0;
      while (node && guard++ < 6000) {
        const raw = normalizeText(node.nodeValue);
        if (raw && raw.length >= 3 && raw.length <= 200) {
          const m = raw.match(INLINE_OPTION_RE);
          if (m) {
            const letter = m[1].toUpperCase();
            const rest = m[2].trim();
            // 字母后面必须是中文，避免把正文里的英文单词当成选项
            if (rest && /[\u4e00-\u9fa5]/.test(rest) && !usedLetters[letter]) {
              // 从文字节点往上找"选项行"：优先挑包含小方块（勾选框）的那一层
              let probe = node.parentElement;
              let chosen = null;
              let fallbackRow = null;
              for (let k = 0; k < 4 && probe && probe !== ownerDoc.body; k++) {
                // 某一层判为不可见时别急着放弃，继续往上找：
                // 横滑课件里外层的 transform 经常让中间层看起来"在视口外"
                if (inPanel(probe)) break;
                const pr = probe.getClientRects ? probe.getClientRects()[0] : null;
                const pt = elementText(probe);
                const sizeOk = pr && pr.width >= 80 && pr.height >= 18 && pr.height <= 240;
                const textOk = pt.length >= raw.length && pt.length <= raw.length + 120;
                if (sizeOk && textOk) {
                  if (!fallbackRow) fallbackRow = probe;
                  if (findOptionSquare(probe)) { chosen = probe; break; }
                }
                probe = probe.parentElement;
              }
              const row = chosen || fallbackRow || node.parentElement;

              if (row && isVisible(row) && !inPanel(row)) {
                const r2 = row.getClientRects ? row.getClientRects()[0] : null;
                if (r2 && r2.width >= 80 && r2.height >= 18 && r2.height <= 240) {
                  let dup = false;
                  for (let k = 0; k < usedRows.length; k++) {
                    if (usedRows[k] === row || usedRows[k].contains(row) || row.contains(usedRows[k])) { dup = true; break; }
                  }
                  if (!dup) {
                    usedLetters[letter] = true;
                    usedRows.push(row);
                    const square = findOptionSquare(row);
                    options.push({
                      el: square || row,
                      square: square,
                      row: row,
                      text: rest,
                      letter: letter
                    });
                  }
                }
              }
            }
          }
        }
        node = walker.nextNode();
      }
    }

    if (options.length < 2) return null;
    options.sort(function (a, b) { return a.letter < b.letter ? -1 : 1; });

    const stem = guessStemFromPage();
    if (!stem) return null;
    // 题干不能长得跟某个选项一样（防止把选项当题干）
    for (let i = 0; i < options.length; i++) {
      if (stem.text === options[i].text) return null;
    }

    const submit = findSubmitButton();
    if (!submit) return null;

    const pageText = elementText(document.body);
    let typeHint = '';
    if (/多选题|不定项|多选/.test(pageText)) typeHint = '多选题，正确答案可能不止一个';
    else if (/单选题|单选/.test(pageText)) typeHint = '单选题，只有一个正确答案';
    else if (/判断题/.test(pageText)) typeHint = '判断题';

    return {
      stem: stem.text,
      stemEl: stem.el,
      options: options,
      submit: submit,
      kind: 'inline',
      typeHint: typeHint
    };
  }

  /* ------------------------------------------------------------------
   * 统一识别器：不再按"布局"分家，而是把所有选项写法归到同一套解析
   *   - 字母单独成元素（A 太空）
   *   - 字母与文字同一行（A 社会安全是…）
   *   - 带「选项」前缀（选项 A）
   *   - 带自绘小方块 / input 勾选框
   * 做法：先找"锚点文本"（整段就是标签，或以字母+中文开头），再向上找行容器，
   * 最后统一决定点哪里：字母元素 → 小方块 → 整行。
   * ------------------------------------------------------------------ */
  /** 从锚点向上找选项行：优先包含小方块的那一层 */
  function resolveOptionRow(startEl) {
    let probe = startEl;
    let withSquare = null;
    let best = null;
    let bestLen = -1;

    for (let k = 0; k < 5 && probe && probe.nodeType === 1; k++) {
      if (probe === document.body || probe === document.documentElement) break;
      if (inPanel(probe) || !isVisible(probe)) break;

      const r = probe.getClientRects ? probe.getClientRects()[0] : null;
      const t = elementText(probe);
      const sizeOk = r && r.width >= 40 && r.height >= 16 && r.height <= 240;

      if (sizeOk && t) {
        const hasSquare = !!findOptionSquare(probe) ||
          !!(probe.querySelector && probe.querySelector('input[type="radio"],input[type="checkbox"]'));
        if (!withSquare && hasSquare) withSquare = { el: probe, rect: r };

        // 关键：像「选项 A」这种小牌子会单独占一层，那一层只有 3 个字，
        // 真正的一行是"标签 + 深色按钮"。所以要取"文字最长又不至于吞掉整道题"的那一层。
        if (t.length > bestLen && t.length <= 200) {
          bestLen = t.length;
          best = { el: probe, rect: r };
        }
      }
      probe = probe.parentElement;
    }

    return withSquare || best;
  }

  function findAnyLetterQuiz() {
    const roots = collectRoots();
    const anchors = [];

    for (let d = 0; d < roots.length; d++) {
      const root = roots[d];
      if (!root) continue;

      const isDoc = root.nodeType === 9;
      const ownerDoc = isDoc ? root : (root.ownerDocument || document);
      const host = isDoc ? root.body : root;
      if (!host) continue;

      let walker = null;
      try {
        const view = ownerDoc.defaultView || window;
        const SHOW_TEXT = (view.NodeFilter && view.NodeFilter.SHOW_TEXT) || 4;
        walker = ownerDoc.createTreeWalker(host, SHOW_TEXT, null, false);
      } catch (e) { continue; }

      let node = walker.nextNode();
      let guard = 0;
      while (node && guard++ < 6000) {
        const raw = normalizeText(node.nodeValue);
        if (raw) {
          // 写法一：整段就是一个标签（A / 选项A / A.）
          if (raw.length <= 8) {
            const l1 = matchOptionLabel(raw);
            if (l1) anchors.push({ letter: l1, el: node.parentElement, rest: '', mode: 'label' });
          }
          // 写法二：以字母开头的短句（A 社会安全是…）
          if (raw.length >= 3 && raw.length <= 200) {
            const m = raw.match(INLINE_OPTION_RE);
            if (m && /[\u4e00-\u9fa5]/.test(m[2])) {
              anchors.push({ letter: m[1].toUpperCase(), el: node.parentElement, rest: m[2].trim(), mode: 'inline' });
            }
          }
        }
        node = walker.nextNode();
      }
    }

    if (anchors.length < 2) return null;

    const options = [];
    const usedLetters = {};
    const usedRows = [];

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (usedLetters[a.letter]) continue;
      if (!a.el || inPanel(a.el)) continue;

      const row = resolveOptionRow(a.el);
      if (!row) continue;

      let dup = false;
      for (let m = 0; m < usedRows.length; m++) {
        if (usedRows[m] === row.el || usedRows[m].contains(row.el) || row.el.contains(usedRows[m])) { dup = true; break; }
      }
      if (dup) continue;

      const square = findOptionSquare(row.el);
      const input = row.el.querySelector ? row.el.querySelector('input[type="radio"],input[type="checkbox"]') : null;
      const rowText = elementText(row.el);
      const text = (a.rest || stripOptionLabel(rowText)).trim();
      if (!text || text.length > 160) continue;

      const labelEl = a.mode === 'label' ? a.el : null;
      const labelText = labelEl ? normalizeText(elementText(labelEl)) : '';
      // 只有"整块就是个字母"的标签本身才是可靠的点击点（用户实测点字母能选中）；
      // 像「选项 A」这种小牌子往往只是装饰，真正可点的是旁边那块深色按钮
      const bareLetter = labelEl && /^[A-Ha-h]$/.test(labelText);
      const contentEl = pickRowContent(row.el, labelEl);

      usedLetters[a.letter] = true;
      usedRows.push(row.el);

      options.push({
        el: bareLetter ? labelEl : (square || contentEl || row.el),
        labelEl: labelEl,
        contentEl: contentEl,
        square: square,
        input: input,
        row: row.el,
        rect: row.rect,
        text: text,
        letter: a.letter
      });
    }

    if (options.length < 2) return null;
    options.sort(function (x, y) {
      const tx = x.rect ? x.rect.top : 0;
      const ty = y.rect ? y.rect.top : 0;
      return tx - ty;
    });

    const pageText = elementText(document.body);
    const quizSignal = /多选题|单选题|判断题|不定项|选项\s*[A-H]|请选择|以下哪/i.test(pageText);

    let typeHint = '';
    if (/多选题|不定项|多选/.test(pageText)) typeHint = '多选题，正确答案可能不止一个';
    else if (/单选题|单选/.test(pageText)) typeHint = '单选题，只有一个正确答案';
    else if (/判断题/.test(pageText)) typeHint = '判断题';

    const stem = guessStemFromPage();
    const submit = findSubmitButton();

    // 受理条件放宽：只要"页面上写着多选题/选项X"这种明确信号，
    // 即使没取到题干、没找到提交按钮，也按选项直接点（用户要求：出现多选题和 ABCD 就试试点）
    if (!stem && !quizSignal) return null;
    if (!submit && !quizSignal) return null;

    if (stem) {
      for (let i = 0; i < options.length; i++) {
        if (stem.text === options[i].text) return null;   // 题干和选项一样，说明认错了
      }
    }

    return {
      stem: stem ? stem.text : '',
      stemEl: stem ? stem.el : null,
      options: options,
      submit: submit || null,
      kind: 'unified',
      typeHint: typeHint,
      loose: !stem || !submit
    };
  }

  /**
   * 图片题兜底：这类课件把题干画在图片上、选项做成图片按钮（class 含 aq-item），
   * DOM 里没有任何文字，DeepSeek 也读不到题干。
   * 按用户一贯要求——"多选一般全选、点 ABCD 也能过、遇到就试试点"——
   * 认出答题区后把所有选项按钮都点一遍，再点确定。不依赖文字、不调用 AI。
   */
  function findImageQuiz() {
    const all = queryAllDeep('[class*="aq-item"],[class*="btn-aq"],[class*="aqItem"]');
    let optionEls = [];
    let submit = null;

    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (inPanel(el) || !isVisible(el) || isDisabled(el)) continue;
      const cls = typeof el.className === 'string' ? el.className : '';

      // btn-aq 是"确定"，btn-aq-item 才是选项；两者都含 aq-item 子串，要分清
      if (/btn-aq-item/.test(cls)) {
        optionEls.push(el);
      } else if (/btn-aq/.test(cls) && !submit) {
        const t = elementText(el);
        if (!t || /确定|提交|完成|下一题/.test(t)) submit = { el: el, text: t || '确定' };
      }
    }

    // 去重：外层容器若包着别的选项，只留最内层（避免一次点击连带点到整组）
    const options = [];
    for (let i = 0; i < optionEls.length; i++) {
      let nested = false;
      for (let j = 0; j < optionEls.length; j++) {
        if (i === j) continue;
        if (optionEls[j] !== optionEls[i] && optionEls[j].contains(optionEls[i])) { nested = true; break; }
      }
      if (!nested) options.push(optionEls[i]);
    }

    // 兜底：快照里常只列出 aq-item 容器，选项按钮是里面的小图片（面积不够没上榜）。
    // 这时进容器里找可点的图片/链接当选项，但要排除验证码区域。
    if (options.length < 2) {
      const boxes = queryAllDeep('[class*="aq-item"]');
      for (let i = 0; i < boxes.length && options.length < 8; i++) {
        const box = boxes[i];
        if (inPanel(box) || !isVisible(box)) continue;
        if (/btn-aq/.test(typeof box.className === 'string' ? box.className : '')) continue;
        if (box.closest && box.closest('[class*="captcha"],[class*="verify"],[class*="tencent"]')) continue;
        const kids = box.querySelectorAll('img,a,[role="button"],[class*="item"],[class*="btn"],li');
        for (let k = 0; k < kids.length && options.length < 8; k++) {
          const el = kids[k];
          if (inPanel(el) || !isVisible(el) || isDisabled(el)) continue;
          const r = el.getClientRects ? el.getClientRects()[0] : null;
          if (!r || r.width < 24 || r.height < 20) continue;
          if (options.indexOf(el) !== -1) continue;
          options.push(el);
        }
      }
    }

    // 关键兜底：整道题画在一张图上（题干+方块+确定都在图里），
    // DOM 里根本没有选项元素——用题图造"虚拟选项"，每个选项记一次坐标点击。
    if (options.length < 2) {
      // 但结果页（只有一个孤立按钮、图片名 af/at 像 answer-fail/true）不能当题目造选项，
      // 否则 findQuiz 一直返回真，findResultContinue 永远不让位 → 卡在结果页
      let aqCount = 0;
      try {
        const aq = queryAllDeep('[class*="btn-aq"],[class*="aq-btn"]');
        for (let i = 0; i < aq.length; i++) {
          if (!inPanel(aq[i]) && isVisible(aq[i])) aqCount++;
        }
      } catch (e) { /* 忽略 */ }
      const imgForCheck = findQuestionImage();
      const srcName = imgForCheck ? String(imgForCheck.getAttribute('src') || '').toLowerCase() : '';
      const looksResult = aqCount === 1 && /(^|[^a-z])(af|at|result|success|fail)\d*\./.test(srcName);
      if (looksResult) return null;

      const img = imgForCheck;
      if (img) {
        const r = img.getClientRects ? img.getClientRects()[0] : null;
        if (r && r.width > 120 && r.height > 120) {
          const rows = CONFIG.quiz.imageOptionRows;
          for (let i = 0; i < rows.length; i++) {
            options.push({ img: img, rx: CONFIG.quiz.imageOptionX, ry: rows[i], idx: i });
          }
          if (!submit) {
            // 「确定」也在图下方，按图片底部中间造一个虚拟提交点
            submit = { el: img, rx: 0.5, ry: 0.94, virtual: true, text: '确定' };
          }
        }
      }
    }

    if (options.length < 2) return null;                 // 至少两个选项才像题
    options.sort(function (a, b) {
      if (a.img || b.img) return (a.idx || 0) - (b.idx || 0);
      const ra = a.getClientRects ? a.getClientRects()[0] : null;
      const rb = b.getClientRects ? b.getClientRects()[0] : null;
      if (!ra || !rb) return 0;
      return Math.abs(ra.top - rb.top) > 12 ? ra.top - rb.top : ra.left - rb.left;
    });

    if (!submit) submit = findSubmitButton();

    return {
      stem: '',
      stemEl: null,
      options: options.slice(0, 8).map(function (el, idx) {
        if (el.img) return { el: el.img, virtual: true, rx: el.rx, ry: el.ry,
          text: '图片选项' + (idx + 1), letter: String.fromCharCode(65 + idx) };
        return { el: el, text: '图片选项' + (idx + 1), letter: String.fromCharCode(65 + idx) };
      }),
      submit: submit,
      imageEl: findQuestionImage(),
      kind: 'image',
      typeHint: '多选'
    };
  }

  function findQuiz() {
    return findFormQuiz() || findLetterRowQuiz() || findJudgeQuiz() ||
      findInlineLetterQuiz() || findPrefixRowQuiz() || findAnyLetterQuiz() ||
      findTextQuiz() || findImageQuiz();
  }

  function readAnswerCache() {
    const cache = Store.get('answer_cache', null);
    return cache && typeof cache === 'object' ? cache : {};
  }

  function writeAnswerCache(cache) {
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      keys.slice(0, keys.length - 300).forEach(function (k) { delete cache[k]; });
    }
    Store.set('answer_cache', cache);
  }

  function askDeepSeek(key, quiz) {
    const letters = 'ABCD'.slice(0, quiz.options.length).split('');
    const optionText = quiz.options.map(function (o) { return o.text; }).join('\n');
    const messages = [
      { role: 'system', content: '你是安全教育题库的答题助手。只输出正确选项的字母，例如 A，多选题输出全部正确字母如 ABC，不要输出解释、标点或其它任何文字。' },
      {
        role: 'user',
        content: (quiz.typeHint ? '题型：' + quiz.typeHint + '\n' : '') +
          '题目：' + quiz.stem + '\n选项：\n' + optionText +
          '\n可选字母：' + letters.join('、') +
          (quiz.typeHint && quiz.typeHint.indexOf('多选') !== -1 ? '\n这是多选题，请输出所有正确选项的字母。' : '') +
          '\n只输出字母。'
      }
    ];

    return callDeepSeek(key, messages).then(function (content) {
      if (!content) return null;
      const found = content.toUpperCase().match(/[A-D]/g) || [];
      const uniq = [];
      found.forEach(function (c) {
        if (letters.indexOf(c) !== -1 && uniq.indexOf(c) === -1) uniq.push(c);
      });
      return uniq.length ? uniq : null;
    });
  }

  /** 选项的"选中状态指纹"：类名/aria/图片地址任何一处变化都算选中状态变了 */
  function optionSignature(opt) {
    const root = opt.row || opt.el;
    if (!root) return '';
    const els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'), 0, 20));
    const parts = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      parts.push(typeof el.className === 'string' ? el.className : '');
      if (el.getAttribute) {
        parts.push(el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '');
      }
      if (el.tagName === 'IMG' && el.getAttribute) parts.push(el.getAttribute('src') || '');
      if (el.style && el.style.backgroundImage) parts.push(el.style.backgroundImage);
    }
    return parts.join('|');
  }

  /**
   * 点选一个选项并确认生效：
   * 点完 380ms 看"状态指纹"有没有变；没变就换整行再点一次（最多补一次，
   * 避免反复点击把多选状态点回去）。返回 Promise<boolean> 表示是否确认选中。
   */
  /** 按题图的比例坐标点一下（用于整道题画在图上、没有 DOM 选项的情况） */
  function clickImagePoint(opt) {
    try {
      const img = opt.el;
      const r = img.getClientRects ? img.getClientRects()[0] : null;
      if (!r) return false;
      const x = r.left + r.width * opt.rx;
      const y = r.top + r.height * opt.ry;
      const view = (img.ownerDocument && img.ownerDocument.defaultView) || window;
      const base = {
        bubbles: true, cancelable: true, composed: true, view: view,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0
      };
      // 点在图片所在文档该坐标命中的真实元素上（可能是叠在图上的透明热区）
      const hit = view.document.elementFromPoint
        ? view.document.elementFromPoint(x, y) : null;
      const target = hit || img;
      if (typeof view.PointerEvent === 'function') {
        try { target.dispatchEvent(new view.PointerEvent('pointerdown', base)); } catch (e) {}
        try { target.dispatchEvent(new view.PointerEvent('pointerup', base)); } catch (e) {}
      }
      try { target.dispatchEvent(new view.MouseEvent('mousedown', base)); } catch (e) {}
      try { target.dispatchEvent(new view.MouseEvent('mouseup', base)); } catch (e) {}
      try { target.dispatchEvent(new view.MouseEvent('click', base)); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }

  function clickOptionSafely(opt) {
    return new Promise(function (resolve) {
      const chain = [];
      const push = function (el) { if (el && chain.indexOf(el) === -1) chain.push(el); };
      push(opt.el);
      push(opt.contentEl);
      push(opt.square);
      push(opt.labelEl);
      push(opt.row);

      const before = optionSignature(opt);
      let attempt = 0;

      const syncInput = function () {
        if (opt.input && !opt.input.checked) {
          try {
            opt.input.checked = true;
            if (typeof Event === 'function') {
              opt.input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) { /* 忽略 */ }
        }
      };

      const tryNext = function () {
        if (attempt >= chain.length || attempt >= 2) { resolve(false); return; }
        const el = chain[attempt++];
        try { simulateClick(el); } catch (e) { /* 忽略 */ }
        syncInput();

        setTimeout(function () {
          if (optionSignature(opt) !== before) resolve(true);
          else tryNext();
        }, 380);
      };

      tryNext();
    });
  }

  /** 生成图片题的候选组合：先全选，再逐个单选，再其他组合（覆盖所有非空子集） */
  function imageCombos(n) {
    if (n <= 0) return [];
    const letters = [];
    for (let i = 0; i < n; i++) letters.push(String.fromCharCode(65 + i));
    const list = [];
    const seen = {};
    const add = function (combo) {
      const sig = combo.join('');
      if (seen[sig]) return;
      seen[sig] = true;
      list.push(combo);
    };
    add(letters.slice());                       // 第一次：全选
    for (let i = 0; i < n; i++) add([letters[i]]); // 然后每个单选
    const masks = [];
    for (let m = 1; m < (1 << n); m++) masks.push(m);
    masks.sort(function (a, b) {
      const pc = function (x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
      return pc(b) - pc(a) || a - b;
    });
    for (let i = 0; i < masks.length; i++) {
      const combo = [];
      for (let k = 0; k < n; k++) if (masks[i] & (1 << k)) combo.push(letters[k]);
      add(combo);
    }
    return list;
  }

  /** 图片题每答一次换一组：答错返回重选后，下一轮自动试另一种 */
  /** 图片题的稳定标识：题图 src 优先，否则用选项数量兜底 */
  function imageQuizKey(quiz) {
    const src = (quiz.imageEl && quiz.imageEl.getAttribute)
      ? String(quiz.imageEl.getAttribute('src') || '') : '';
    return src ? 'img:' + src : 'n' + (quiz.options ? quiz.options.length : 0);
  }

  /**
   * 选出这次要试的答案：AI 给的字母若这道题已试过，就换一个没试过的组合。
   * 这样答错返回重选后，不会一遍遍撞同一个错误答案。
   */
  function pickAnswerWithHistory(quiz, aiLetters) {
    const key = imageQuizKey(quiz);
    let tried = state.imageTriedAnswers[key];
    if (!tried) { tried = []; state.imageTriedAnswers[key] = tried; }
    const sig = function (arr) { return (arr || []).slice().sort().join(''); };

    // AI 的答案没试过 → 用它
    if (aiLetters && aiLetters.length && tried.indexOf(sig(aiLetters)) === -1) {
      tried.push(sig(aiLetters));
      return { letters: aiLetters, fromAI: true };
    }

    // AI 没给答案，或给的答案已试过 → 从组合序列里挑一个没试过的
    const combos = imageCombos(quiz.options.length);
    for (let i = 0; i < combos.length; i++) {
      const c = combos[i];
      if (tried.indexOf(sig(c)) === -1) {
        tried.push(sig(c));
        return { letters: c, fromAI: false };
      }
    }
    // 全部试过了：从头循环（这时确实没招了）
    const fallback = combos[state.imageTries[key] % combos.length] || aiLetters;
    state.imageTries[key] = (state.imageTries[key] || 0) + 1;
    return { letters: fallback, fromAI: false };
  }

  function nextImageCombo(quiz) {
    const n = quiz.options.length;
    const key = 'n' + n + '_' + quiz.options.map(function (o) {
      const r = o.el.getClientRects ? o.el.getClientRects()[0] : null;
      return r ? Math.round(r.left) + 'x' + Math.round(r.top) : '?';
    }).join('|');
    const combos = imageCombos(n);
    const tried = state.imageTries[key] || 0;
    state.imageTries[key] = tried + 1;
    return combos[tried % combos.length];
  }

  /**
   * 找课件里"最大的那张正文图片"当题干图。
   * 题干/选项都画在图上（img:dt01.png / af01.png），DOM 里没文字，只能让 AI 看图。
   * 要求：可见、面积够大、排除验证码区域（那堆藏在 -1000000 的 tencent-captcha）。
   */
  function findQuestionImage() {
    const imgs = queryAllDeep('img,canvas');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      if (inPanel(el) || !isVisible(el)) continue;
      if (el.closest && el.closest('[class*="captcha"],[class*="verify"],[class*="tencent"]')) continue;
      const r = el.getClientRects ? el.getClientRects()[0] : null;
      if (!r || r.width < 120 || r.height < 80) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return bestArea >= 20000 ? best : null;
  }

  /** 把图片元素转成 base64（JPEG 压缩，控制体积）。跨域图片转不了，返回 null */
  function imageToBase64(img) {
    try {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) {
        const r = img.getClientRects ? img.getClientRects()[0] : null;
        w = r ? r.width : 0; h = r ? r.height : 0;
      }
      if (!w || !h) return null;
      // 限制最大边，避免 base64 过大（视觉模型会缩放，1024 足够读题）
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));

      let canvas = null;
      if (img.tagName === 'CANVAS') {
        canvas = img;
      } else {
        canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, w, h);
      }
      const url = canvas.toDataURL('image/jpeg', 0.8);
      if (!url || url.indexOf('base64,') === -1) return null;
      return url.slice(url.indexOf('base64,') + 7);
    } catch (e) {
      return null;   // 跨域画布被污染等，退回穷举
    }
  }

  /**
   * 让视觉模型看着题图作答。DeepSeek 的 deepseek-v4-flash-vision-exp
   * 接受 content 为数组，图片用 image_url 的 data URL 传（同一把 key、同一 endpoint）。
   * @returns Promise<字母数组|null>
   */
  function askVision(key, quiz) {
    const img = quiz.imageEl || findQuestionImage();
    if (!img) return Promise.resolve(null);
    const b64 = imageToBase64(img);
    if (!b64) {
      log('题图无法转成可发送的数据（跨域限制），改用穷举组合', 'warn');
      return Promise.resolve(null);
    }

    const n = quiz.options.length;
    const letters = [];
    for (let i = 0; i < n && i < 26; i++) letters.push(String.fromCharCode(65 + i));
    const content = [
      {
        type: 'text',
        text: '这是一张安全教育课程的选择题截图（题目和选项都画在图片里，选项前可能没有 A/B/C 字母，只有方块）。' +
          '请先读出题目和所有选项，判断正确答案，然后按选项的位置回答：' +
          '从上往下第 1 个选项记为 A，第 2 个记为 B，第 3 个记为 C，第 4 个记为 D。' +
          '只输出字母，例如 B；多选题输出全部正确字母，例如 ABC。不要输出解释或任何其它文字。' +
          '\n共 ' + n + ' 个选项，可选字母：' + letters.join('、') + '\n只输出字母。'
      },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
    ];
    const messages = [{ role: 'user', content: content }];

    return callDeepSeekRaw(key, messages, { model: CONFIG.quiz.visionModel }).then(function (res) {
      if (!res.ok) {
        log('AI 识图失败：' + res.message + '，改用穷举组合', 'warn');
        return null;
      }
      // 只认选项范围内的字母；若 AI 用中文"第一个/选B"回答，也能提取
      const raw = String(res.content || '').toUpperCase();
      const found = raw.match(/[A-Z]/g) || [];
      const uniq = [];
      found.forEach(function (c) {
        if (letters.indexOf(c) !== -1 && uniq.indexOf(c) === -1) uniq.push(c);
      });
      if (!uniq.length) { log('AI 识图未返回可用字母（原文：' + String(res.content).slice(0, 50) + '）', 'warn'); return null; }
      log('AI 识图原文：' + String(res.content).slice(0, 60) + ' → ' + uniq.join(''));
      return uniq;
    }).catch(function () { return null; });
  }

  /**
   * 找不到任何可点元素时，让 AI 看着课件画面判断"下一步点哪里"。
   * 返回 {rx, ry}（0~1 的图片内比例）或 null。
   */
  function askWhereToClick(key, img) {
    const b64 = imageToBase64(img);
    if (!b64) return Promise.resolve(null);
    const content = [
      {
        type: 'text',
        text: '这是安全微课课件画面截图。请判断当前这一步应该点击哪里才能继续学习' +
          '（例如「下一页」「确定」「开始」「返回重选」等按钮）。' +
          '只返回一个 JSON：{"x":0到1000,"y":0到1000}，x/y 是要点位置相对图片宽高的千分比。' +
          '如果画面上没有需要点击的按钮、或已经完成，返回 {"none":true}。不要输出其它文字。'
      },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
    ];
    return callDeepSeekRaw(key, [{ role: 'user', content: content }],
      { model: CONFIG.quiz.visionModel, jsonMode: true }).then(function (res) {
      if (!res.ok) { log('AI 定位失败：' + res.message, 'warn'); return null; }
      let data = null;
      try { data = JSON.parse(String(res.content).replace(/```[a-z]*|```/g, '').trim()); } catch (e) { return null; }
      if (!data || data.none) return null;
      const x = Number(data.x), y = Number(data.y);
      if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 1000) return null;
      return { rx: x / 1000, ry: y / 1000 };
    }).catch(function () { return null; });
  }

  /** 空转到阈值时，求助 AI 看图定位要点的按钮（带冷却，避免反复调用） */
  function maybeAiFindClick() {
    if (!CONFIG.quiz.aiFindClick) return;
    if (IS_TOP && hasCrossFrame() && FRAMES_SEEN.length) return;  // 顶层空转正常，交给帧
    if (state.zeroScans < CONFIG.quiz.aiFindAfter) return;
    if (now() - state.aiFindAt < CONFIG.quiz.aiFindCooldownMs) return;
    if (state.answering || state.aiFinding) return;
    const key = getKey();
    if (!key) return;
    const img = findQuestionImage();
    if (!img) return;

    state.aiFinding = true;
    state.aiFindAt = now();
    state.lastAction = 'AI 正在看画面找可点位置…';
    log('找不到可点元素，让 AI 看着课件画面判断点哪里…');
    updateStatusLine();

    askWhereToClick(key, img).then(function (pos) {
      state.aiFinding = false;
      if (!pos) { log('AI 没找到需要点击的位置', 'warn'); return; }
      log('AI 判断应点击画面 (' + Math.round(pos.rx * 100) + '%, ' + Math.round(pos.ry * 100) + '%)');
      clickImagePoint({ el: img, rx: pos.rx, ry: pos.ry });
      state.lastAction = '已按 AI 指引点击画面';
      state.zeroScans = 0;
      updateStatusLine();
      scheduleScan('AI 定位点击后', rand(CONFIG.scan.minInterval, CONFIG.scan.maxInterval));
    }).catch(function () { state.aiFinding = false; });
  }

  function answerQuiz() {
    if (state.answering) return false;

    const quiz = findQuiz();
    if (!quiz) return false;

    const imgSrc = (quiz.kind === 'image' && quiz.imageEl) ? String(quiz.imageEl.getAttribute('src') || '') : '';
    const cacheKey = hashText(quiz.stem + '|' + imgSrc + '|' + quiz.options.map(function (o) { return o.text; }).join('|'));
    const answerGap = quiz.kind === 'image' ? 6000 : 30000;
    if (state.lastAnsweredKey === cacheKey && now() - state.lastAnsweredAt < answerGap) return false;

    state.answering = true;
    const cache = readAnswerCache();
    const cached = cache[cacheKey];

    const applyAnswer = function (letters, fromCache) {
      const hit = quiz.options.filter(function (o) { return letters.indexOf(o.letter) !== -1; });
      if (!hit.length) {
        log('答案无法映射到页面选项，跳过本题', 'warn');
        return;
      }

      Promise.all(hit.map(function (opt) {
        if (opt.virtual) return Promise.resolve(clickImagePoint(opt));
        if (quiz.kind === 'image') { try { simulateClick(opt.el); } catch (e) {} return Promise.resolve(true); }
        return clickOptionSafely(opt);
      })).then(function (results) {
        const failed = results.filter(function (ok) { return !ok; }).length;
        state.answering = false;   // 点完选项才解锁，AI 异步期间不会再触发同一题

        state.lastAnsweredKey = cacheKey;
        state.lastAnsweredAt = now();
        state.lastAction = '已作答：' + letters.join('') + (failed ? '（' + failed + ' 项待确认）' : '');
        log((fromCache ? '（缓存）' : '（AI）') + '已选 ' + letters.join('') + '：' +
          (quiz.stem ? quiz.stem.slice(0, 20) + '…' : '（未取到题干，按选项直接点）') +
          (failed ? '；其中 ' + failed + ' 项点击后没看到选中状态变化' : ''), failed ? 'warn' : undefined);

        if (!quiz.submit) log('选项已点，但没找到「提交/确定」按钮，请手动提交', 'warn');

        if (CONFIG.quiz.submitAfterAnswer && quiz.submit) {
          setTimeout(function () {
            if (!state.running) return;
            try {
              if (quiz.submit.virtual) {
                clickImagePoint({ el: quiz.submit.el, rx: quiz.submit.rx, ry: quiz.submit.ry });
              } else {
                simulateClick(quiz.submit.el);
              }
              log('已点击提交');
            } catch (e) { /* 忽略 */ }
          }, CONFIG.quiz.submitDelay);
        }
      }).catch(function () { state.answering = false; });
    };

    if (cached && Array.isArray(cached) && cached.length) {
      applyAnswer(cached, true);
      state.answering = false;
      return true;
    }

    // 图片题：题干画在图上，先让 AI 看着题图作答（你接的 API 就该用在这里）。
    // 没填 Key、识图失败、跨域转不了图，才退回"全选→逐组穷举"。
    if (quiz.kind === 'image') {
      const imageKey = getKey();
      if (CONFIG.quiz.visionEnabled && imageKey) {
        log('图片题：正在让 AI 看着题图作答…');
        state.lastAction = 'AI 正在识别题图…';
        updateStatusLine();
        askVision(imageKey, quiz).then(function (letters) {
          const pick = pickAnswerWithHistory(quiz, letters);
          if (pick.fromAI) {
            log('AI 识图作答：' + pick.letters.join(''));
          } else {
            log((letters && letters.length ? 'AI 答案已试过，' : '识图无果，') +
              '自动换新组合 ' + pick.letters.join('') + '（避开重复错误）');
          }
          applyAnswer(pick.letters, false);
        }).catch(function () { state.answering = false; });
        return true;
      }
      // 没有 Key / 关闭识图：全选 + 答错换组合
      state.answering = false;
      const pick = pickAnswerWithHistory(quiz, null);
      log('图片题（未启用识图），本次尝试组合 ' + pick.letters.join('') + '（避开已试过的）');
      applyAnswer(pick.letters, false);
      return true;
    }

    // 普通多选题按"全选"处理：这类题库里多选基本等于全部正确，比让 AI 猜更稳。
    // 放在 Key 检查之前——全选不需要调用 AI
    if (quiz.typeHint && quiz.typeHint.indexOf('多选') !== -1 && CONFIG.quiz.multiSelectAll) {
      state.answering = false;
      const all = quiz.options.map(function (o) { return o.letter; });
      log('多选题，按全选处理：' + all.join(''));
      applyAnswer(all, false);
      return true;
    }

    // 需要 AI 判断时才要求 Key
    const key = getKey();
    if (!key) {
      state.answering = false;
      state.lastAction = '检测到题目，但未配置 DeepSeek Key';
      log('检测到题目（' + quiz.stem.slice(0, 24) + '…），未填 API Key，跳过', 'warn');
      updateStatusLine();
      return false;
    }

    askDeepSeek(key, quiz).then(function (letters) {
      state.answering = false;
      if (!letters) {
        log('AI 未给出可用答案，本题请人工处理', 'warn');
        return;
      }
      cache[cacheKey] = letters;
      writeAnswerCache(cache);
      applyAnswer(letters, false);
    }).catch(function (err) {
      state.answering = false;
      log('答题流程异常：' + (err && err.message ? err.message : err), 'error');
    });

    return true;
  }

  /* ==================================================================
   * 十四、互动任务（小游戏）
   * ================================================================== */
  const gameAgent = {
    busy: false, actions: 0, lastSceneHash: '', lastSceneAt: 0,
    lastSig: '', repeatCount: 0, lastActionAt: 0,
    canvasHinted: false, noKeyHinted: false, limitHinted: false
  };

  function resetGameAgent() {
    gameAgent.actions = 0;
    gameAgent.lastSceneHash = '';
    gameAgent.lastSceneAt = 0;
    gameAgent.lastSig = '';
    gameAgent.repeatCount = 0;
    gameAgent.lastActionAt = 0;
    gameAgent.canvasHinted = false;
    gameAgent.noKeyHinted = false;
    gameAgent.limitHinted = false;
  }

  function findSceneRoot() {
    let best = null;
    let bestArea = 0;
    let kind = '';

    for (let i = 0; i < SCENE_ROOT_SELECTORS.length; i++) {
      const nodes = queryAllDeep(SCENE_ROOT_SELECTORS[i]);
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        if (inPanel(el) || !isVisible(el)) continue;

        const rect = el.getClientRects()[0];
        const area = rect.width * rect.height;
        if (area < 20000) continue;

        if (area > bestArea) {
          best = el;
          bestArea = area;
          kind = el.tagName === 'CANVAS' ? 'canvas' : 'game';
        }
      }
    }

    if (!best) return null;
    const root = best.tagName === 'CANVAS' ? (best.parentElement || best) : best;
    return { root: root, kind: kind, hasCanvas: kind === 'canvas' || !!root.querySelector('canvas') };
  }

  function nodeLabel(el) {
    const text = elementText(el);
    if (text) return text;

    const attr = el.getAttribute
      ? (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title')) : '';
    if (attr) return normalizeText(attr);

    const src = el.getAttribute ? el.getAttribute('src') : '';
    if (src && src.indexOf('data:') !== 0) {
      const name = src.split('?')[0].split('/').pop();
      if (name) return normalizeText(name.replace(/\.[a-z0-9]+$/i, ''));
    }
    return '';
  }

  function captureScene() {
    const found = findSceneRoot();
    if (!found) return null;

    const nodes = [];
    const usedText = {};
    const nodeEls = found.root.querySelectorAll(SCENE_NODE_SELECTOR);
    for (let i = 0; i < nodeEls.length && nodes.length < CONFIG.interactive.maxNodes; i++) {
      const el = nodeEls[i];
      if (inPanel(el) || (el.closest && el.closest('nav,footer')) || !isVisible(el)) continue;

      const label = nodeLabel(el);
      if (!label || label.length > CONFIG.interactive.nodeTextMax || usedText[label]) continue;
      usedText[label] = true;
      nodes.push({ el: el, text: label });
    }

    const prompts = [];
    const usedPrompt = {};
    const promptEls = found.root.querySelectorAll(SCENE_PROMPT_SELECTOR);
    for (let i = 0; i < promptEls.length && prompts.length < 6; i++) {
      const el = promptEls[i];
      if (!isVisible(el)) continue;
      const text = elementText(el);
      if (!text || text.length < 4 || text.length > CONFIG.interactive.promptTextMax) continue;
      if (usedPrompt[text]) continue;
      usedPrompt[text] = true;
      prompts.push(text);
    }

    if (!nodes.length && !prompts.length) return null;
    return { kind: found.kind, hasCanvas: found.hasCanvas, root: found.root, prompts: prompts, nodes: nodes };
  }

  const SCENE_SYSTEM_PROMPT = [
    '你是网页互动安全课件的操作决策器。根据页面提示语和可操作元素列表，判断完成任务需要的下一步动作。',
    '只能返回一个 JSON 对象，不要输出解释、不要用 markdown 代码块。格式四选一：',
    '{"action":"click","target":"元素文本原文"}',
    '{"action":"drag","from":"元素文本原文","to":"元素文本原文"}',
    '{"action":"wait"}',
    '{"action":"none"}',
    '规则：',
    '1. target/from/to 必须从给定元素列表里原样复制，不要改写、不要带序号。',
    '2. 提示要求「选择/点击/找出/选出」某个东西时返回 click。',
    '3. 提示要求「拖动/拖到/配对/放入」时返回 drag。',
    '4. 当前页面已经完成、或没有可做的动作时返回 none；信息不足、不确定返回 wait。',
    '5. 一次只返回一个动作，不要编造列表里不存在的元素。'
  ].join('\n');

  function describeScene(scene) {
    const promptText = scene.prompts.length ? scene.prompts.join('\n') : '（页面没有明显提示文字）';
    const nodeText = scene.nodes.map(function (n, i) { return (i + 1) + '. ' + n.text; }).join('\n');
    const canvasNote = scene.hasCanvas ? '\n注意：页面含 canvas 画布，画布内部元素无法被脚本操作。' : '';
    return '页面提示：\n' + promptText + '\n\n可操作元素：\n' + nodeText + canvasNote + '\n\n请给出下一步动作（只输出 JSON）。';
  }

  function parseDecision(content) {
    if (!content) return null;
    let text = String(content).trim();
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { data = JSON.parse(m[0]); } catch (e2) { data = null; }
      }
    }
    if (!data || typeof data !== 'object') return null;

    const action = String(data.action || '').toLowerCase();
    if (['click', 'drag', 'wait', 'none'].indexOf(action) === -1) return null;
    return { action: action, target: data.target, from: data.from, to: data.to, reason: data.reason };
  }

  function decideScene(key, scene) {
    const messages = [
      { role: 'system', content: SCENE_SYSTEM_PROMPT },
      { role: 'user', content: describeScene(scene) }
    ];
    return callDeepSeek(key, messages, { jsonMode: true, temperature: 0 }).then(parseDecision);
  }

  function findSceneNode(scene, text) {
    if (!text) return null;
    const want = normalizeText(text);
    if (!want) return null;

    const exact = scene.nodes.filter(function (n) { return n.text === want; });
    if (exact.length) return exact[0];

    const loose = scene.nodes.filter(function (n) {
      return n.text.indexOf(want) !== -1 || want.indexOf(n.text) !== -1;
    });
    return loose.length === 1 ? loose[0] : null;
  }

  function centerOf(el) {
    if (!el.getClientRects) return null;
    const rect = el.getClientRects()[0];
    if (!rect) return null;
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }

  function makeDataTransfer() {
    try {
      if (typeof DataTransfer === 'function') return new DataTransfer();
    } catch (e) { /* 落到替身 */ }

    const store = {};
    return {
      effectAllowed: 'all', dropEffect: 'move', types: [], files: [],
      setData: function (k, v) { store[k] = String(v); this.types = Object.keys(store); },
      getData: function (k) { return store[k] || ''; },
      clearData: function () { Object.keys(store).forEach(function (k) { delete store[k]; }); this.types = []; }
    };
  }

  function dragBetween(fromEl, toEl) {
    const a = centerOf(fromEl);
    const b = centerOf(toEl);
    if (!a || !b) return false;

    const view = (fromEl.ownerDocument && fromEl.ownerDocument.defaultView) || window;
    const build = function (Ctor, type, x, y, extra) {
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
      if (extra) Object.keys(extra).forEach(function (k) { init[k] = extra[k]; });
      try { return new Ctor(type, init); } catch (e) { return null; }
    };
    const fire = function (el, ev) {
      if (!ev) return;
      try { el.dispatchEvent(ev); } catch (e) { /* 忽略 */ }
    };
    const mouse = function (el, type, x, y) {
      if (typeof view.MouseEvent !== 'function') return;
      fire(el, build(view.MouseEvent, type, x, y));
    };
    const pointer = function (el, type, x, y) {
      if (typeof view.PointerEvent !== 'function') {
        const fallback = type === 'pointerdown' ? 'mousedown' : (type === 'pointermove' ? 'mousemove' : 'mouseup');
        mouse(el, fallback, x, y);
        return;
      }
      fire(el, build(view.PointerEvent, type, x, y, {
        pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: type === 'pointerup' ? 0 : 1
      }));
    };

    const dt = makeDataTransfer();
    const drag = function (el, type, x, y) {
      let ev = null;
      if (typeof view.DragEvent === 'function') ev = build(view.DragEvent, type, x, y, { dataTransfer: dt });
      if (!ev) {
        ev = typeof view.MouseEvent === 'function' ? build(view.MouseEvent, type, x, y) : null;
        if (ev) {
          try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e) { /* 忽略 */ }
        }
      }
      fire(el, ev);
    };

    pointer(fromEl, 'pointerdown', a.x, a.y);
    mouse(fromEl, 'mousedown', a.x, a.y);
    drag(fromEl, 'dragstart', a.x, a.y);

    setTimeout(function () {
      for (let i = 1; i <= 3; i++) {
        const x = Math.round(a.x + (b.x - a.x) * i / 3);
        const y = Math.round(a.y + (b.y - a.y) * i / 3);
        pointer(fromEl, 'pointermove', x, y);
        mouse(toEl, 'mousemove', x, y);
      }
      drag(toEl, 'dragenter', b.x, b.y);
      drag(toEl, 'dragover', b.x, b.y);
    }, 120);

    setTimeout(function () {
      drag(toEl, 'drop', b.x, b.y);
      drag(fromEl, 'dragend', b.x, b.y);
      pointer(toEl, 'pointerup', b.x, b.y);
      mouse(toEl, 'mouseup', b.x, b.y);
    }, 240);

    return true;
  }

  function runSceneAction(scene, decision) {
    if (decision.action === 'click') {
      const node = findSceneNode(scene, decision.target);
      if (!node) {
        log('AI 指定的「' + String(decision.target).slice(0, 20) + '」在页面上找不到，跳过本次动作', 'warn');
        return false;
      }
      if (!node.el.isConnected || !isVisible(node.el)) return false;
      simulateClick(node.el);
      return true;
    }

    if (decision.action === 'drag') {
      const from = findSceneNode(scene, decision.from);
      const to = findSceneNode(scene, decision.to);
      if (!from || !to) {
        log('拖拽的起点或终点找不到，跳过本次动作', 'warn');
        return false;
      }
      return dragBetween(from.el, to.el);
    }

    return false;
  }

  function tickInteractive() {
    if (!CONFIG.interactive.enabled || gameAgent.busy) return;

    if (gameAgent.actions >= CONFIG.interactive.maxActionsPerPage) {
      if (!gameAgent.limitHinted) {
        gameAgent.limitHinted = true;
        log('互动任务操作已达上限 ' + CONFIG.interactive.maxActionsPerPage + ' 次，请人工确认页面状态', 'warn');
      }
      return;
    }

    if (now() - gameAgent.lastActionAt < CONFIG.interactive.minGapBetweenActions) return;

    const key = getKey();
    if (!key) {
      if (!gameAgent.noKeyHinted) {
        gameAgent.noKeyHinted = true;
        log('检测到互动页面，但未配置 DeepSeek Key，互动任务不会执行', 'warn');
      }
      return;
    }

    const scene = captureScene();
    if (!scene) return;

    if (scene.hasCanvas && !gameAgent.canvasHinted) {
      gameAgent.canvasHinted = true;
      log('页面含 canvas 画布，画布内部元素无法自动操作，只能点画布外的按钮', 'warn');
    }

    const sceneHash = hashText(scene.prompts.join('|') + '#' + scene.nodes.map(function (n) { return n.text; }).join('|'));
    if (sceneHash === gameAgent.lastSceneHash && now() - gameAgent.lastSceneAt < CONFIG.interactive.sameSceneCooldown) return;
    gameAgent.lastSceneHash = sceneHash;
    gameAgent.lastSceneAt = now();

    gameAgent.busy = true;
    state.lastAction = '互动任务：正在请 AI 决策…';
    updateStatusLine();

    decideScene(key, scene).then(function (decision) {
      gameAgent.busy = false;

      if (!decision) { log('AI 未给出可执行的互动决策', 'warn'); return; }
      if (decision.action === 'none') { state.lastAction = '互动任务：AI 判断当前无需操作'; updateStatusLine(); return; }
      if (decision.action === 'wait') { state.lastAction = '互动任务：AI 建议等待页面变化'; updateStatusLine(); return; }

      const sig = [decision.action, decision.target || '', decision.from || '', decision.to || ''].join('|');
      if (sig === gameAgent.lastSig) gameAgent.repeatCount++;
      else { gameAgent.lastSig = sig; gameAgent.repeatCount = 0; }

      if (gameAgent.repeatCount >= 3) {
        setRunning(false);
        log('同一动作已重复 3 次且页面无变化，判定卡住，已暂停，请人工处理', 'warn');
        return;
      }

      if (!runSceneAction(scene, decision)) return;

      gameAgent.actions++;
      gameAgent.lastActionAt = now();
      state.lastAction = decision.action === 'drag'
        ? '互动任务：拖拽「' + String(decision.from).slice(0, 12) + '」→「' + String(decision.to).slice(0, 12) + '」'
        : '互动任务：点击「' + String(decision.target).slice(0, 16) + '」';
      log(state.lastAction + (decision.reason ? '（' + String(decision.reason).slice(0, 24) + '）' : ''));
      updateStatusLine();
    }).catch(function (err) {
      gameAgent.busy = false;
      log('互动任务异常：' + (err && err.message ? err.message : err), 'error');
    });
  }

  /* ==================================================================
   * 十五、跨 frame 桥 + 元素选取器
   * 关键点：课件常放在 iframe 里，点击事件不会冒泡到顶层文档。
   * 所以「选取元素」必须广播到每个 frame，由各 frame 自己监听。
   * ================================================================== */
  function postToFrames(message) {
    let frames = [];
    try { frames = document.querySelectorAll('iframe, frame'); } catch (e) { return; }
    for (let i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage(message, '*'); } catch (e) { /* 忽略 */ }
    }
  }

  /** 根据消息来源找到对应的 iframe 元素（用来判断这一帧是不是课件主体） */
  function frameElementFor(source) {
    if (!source) return null;
    let frames = [];
    try { frames = document.querySelectorAll('iframe, frame'); } catch (e) { return null; }
    for (let i = 0; i < frames.length; i++) {
      try { if (frames[i].contentWindow === source) return frames[i]; } catch (err) { /* 忽略 */ }
    }
    return null;
  }

  /** 通知所有子帧清空退避/拉黑（用户点了「继续」时用） */
  function broadcastReset() {
    postToFrames({ wb: FRAME_MSG, action: 'reset-backoff' });
  }

  /** 给所有子帧发"放行"指令：这一帧是微伴页面嵌的课件，可以启动 */
  function broadcastActivate() {
    postToFrames({ wb: FRAME_MSG, action: 'activate' });
  }

  function postToTop(message) {
    if (IS_TOP) return;
    try { window.top.postMessage(message, '*'); } catch (e) { /* 忽略 */ }
  }

  /**
   * 每个帧启动时向顶层报个到。
   * 这是"为什么这个域名没用"的唯一可靠判据：顶层能看到 iframe 元素，
   * 但只有报了到才说明那一帧里的脚本真的跑起来了。
   */
  function announceFrame() {
    if (IS_TOP) return;
    postToTop({
      wb: FRAME_MSG,
      action: 'hello',
      host: location.hostname,
      href: String(location.href).slice(0, 140)
    });
  }

  function selectorSegment(node) {
    let part = node.tagName.toLowerCase();
    const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) {
      const usable = cls.slice(0, 2).map(function (c) { return c.replace(/[^\w-]/g, ''); }).filter(Boolean);
      if (usable.length) part += '.' + usable.join('.');
    }

    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName;
      });
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    }
    return part;
  }

  /** 由短到长拼选择器，取第一个"当前页面唯一命中"的，跨页复用率最高 */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const doc = el.ownerDocument || document;

    const id = el.getAttribute ? el.getAttribute('id') : '';
    if (id && /^[A-Za-z][\w-]*$/.test(id)) {
      try {
        const byId = doc.querySelectorAll('#' + id);
        if (byId.length === 1 && byId[0] === el) return '#' + id;
      } catch (e) { /* 忽略 */ }
    }

    const parts = [];
    let fallback = '';
    let node = el;

    for (let depth = 0; depth < 6 && node && node.nodeType === 1; depth++) {
      if (node === doc.body || node === doc.documentElement) break;
      parts.unshift(selectorSegment(node));
      const selector = parts.join(' > ');

      try {
        const hits = doc.querySelectorAll(selector);
        if (hits.length === 1 && hits[0] === el) return selector;
        if (!fallback && hits.length && hits[0] === el) fallback = selector;
      } catch (e) { /* 继续往上 */ }

      node = node.parentElement;
    }
    return fallback;
  }

  /* 选取态的可见反馈：整页虚线遮罩 + 悬停红框，让用户一眼看出"现在能点哪个" */
  const pickOverlays = new Map();
  const pickHovers = new Map();
  let pickBoundDocs = [];
  let pickerMoveHandler = null;

  function ensurePickUi(doc) {
    if (!doc || !doc.body) return null;

    let overlay = pickOverlays.get(doc) || doc.getElementById('wb-pick-overlay');
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.id = 'wb-pick-overlay';
      overlay.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'z-index:2147483646', 'pointer-events:none', 'box-sizing:border-box',
        'background:rgba(255,90,90,0.06)', 'border:2px dashed rgba(255,90,90,0.8)'
      ].join(';');

      const tip = doc.createElement('div');
      tip.textContent = '选取中：点一下要自动点的元素（Esc 取消）';
      tip.style.cssText = [
        'position:absolute', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
        'background:rgba(28,32,42,0.95)', 'color:#f0d29a', 'padding:8px 14px',
        'border-radius:8px', 'border:1px solid rgba(232,192,125,0.6)', 'white-space:nowrap',
        'font:13px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif'
      ].join(';');
      overlay.appendChild(tip);

      doc.body.appendChild(overlay);
      pickOverlays.set(doc, overlay);
    }
    overlay.style.display = 'block';
    return overlay;
  }

  function ensureHoverBox(doc) {
    if (!doc || !doc.body) return null;
    let box = pickHovers.get(doc) || doc.getElementById('wb-pick-hover');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'wb-pick-hover';
      box.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'display:none',
        'box-sizing:border-box', 'border:2px solid #ff5a5a', 'border-radius:4px',
        'background:rgba(255,90,90,0.12)'
      ].join(';');
      doc.body.appendChild(box);
      pickHovers.set(doc, box);
    }
    return box;
  }

  function removePickUi() {
    pickOverlays.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    pickHovers.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    pickOverlays.clear();
    pickHovers.clear();
  }

  /**
   * 从事件里取"用户真正点到的那个元素"。
   * 直接用 e.target 有两个坑：Web Component 里拿到的是宿主元素；
   * 点在文字上时个别浏览器给的是 Text 节点。
   */
  function pickTargetFromEvent(e) {
    let el = e.target;

    try {
      const path = e.composedPath ? e.composedPath() : null;
      if (path && path.length) {
        for (let i = 0; i < path.length; i++) {
          const node = path[i];
          if (node && node.nodeType === 1) { el = node; break; }
        }
      }
    } catch (err) { /* 忽略 */ }

    if (el && el.nodeType !== 1 && el.parentElement) el = el.parentElement;
    return el && el.nodeType === 1 ? el : null;
  }

  function startPicker(fromMessage) {
    if (pickerActive) {
      if (!fromMessage) stopPicker(true);
      return;
    }
    pickerActive = true;

    // 同源 iframe 直接挂监听（跨域 iframe 收不到点击，靠 postMessage 让它自己开）
    pickBoundDocs = collectDocuments();
    for (let i = 0; i < pickBoundDocs.length; i++) {
      ensurePickUi(pickBoundDocs[i]);
      try { pickBoundDocs[i].documentElement.style.cursor = 'crosshair'; } catch (e) { /* 忽略 */ }
    }
    if (document.body) document.body.style.cursor = 'crosshair';

    let lastPickAt = 0;

    /**
     * 选取处理。要点：
     *  · pointerdown 和 click 都接（有的页面 preventDefault 掉了 click）
     *  · 全程 try/catch —— 以前这里一旦抛异常，选取态就永远停在那里，页面所有点击被吞，
     *    表现就是"点完选取元素后卡住了"
     *  · 点空/点的是 iframe/生成不了选择器时，明确写日志并退出选取，不让用户干等
     */
    pickerHandler = function (e) {
      if (!pickerActive) return;

      try {
        const raw = pickTargetFromEvent(e);
        if (!raw) return;
        if (raw.closest && raw.closest('#wb-auto-panel')) return;
        if (raw.closest && raw.closest('#wb-pick-overlay')) return;

        // 同一次点击会先来 pointerdown 再来 click，第二次直接吞掉
        if (now() - lastPickAt < 500) {
          e.preventDefault();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          return;
        }
        lastPickAt = now();

        e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        if (raw.tagName === 'IFRAME' || raw.tagName === 'FRAME') {
          let src = '';
          try { src = raw.getAttribute('src') || ''; } catch (err) { src = ''; }
          log('你点中的是一整个 iframe（' + (src.split('?')[0].slice(0, 60) || '无地址') +
            '）：里面的按钮属于另一个文档，脚本在这里读不到、也点不到。请刷新一次页面让脚本注入到那个帧里；' +
            '若刷新后仍然如此，点「扫描诊断」把报告发我', 'warn');
          stopPicker(true);
          return;
        }

        // 先按"真实可点节点"取，取到的选择器如果本页一个都命中，退回用户点的那一层
        let el = resolveClickTarget(raw);
        let selector = buildSelector(el);
        let hits = selector ? queryAllDeep(selector).length : 0;

        if ((!selector || !hits) && el !== raw) {
          el = raw;
          selector = buildSelector(el);
          hits = selector ? queryAllDeep(selector).length : 0;
        }

        if (!selector) {
          log('这个元素生成不了稳定选择器（' + describeElement(raw) +
            '），再点一次它的外层或按钮本身', 'warn');
          stopPicker(true);
          return;
        }

        stopPicker(true);

        if (saveCustomSelector(selector)) {
          log('已记住元素：' + selector + '（本页命中 ' + hits + ' 个）');
          if (!IS_TOP) {
            postToTop({ wb: FRAME_MSG, action: 'picked', selector: selector });
          }
          state.lastAction = '已记住选取的元素';
          updateStatusLine();
          scheduleScan('新增自定义元素', 300);
        } else {
          log('这个选择器之前已经记过了，或已达上限 ' + CONFIG.picker.maxCustom + ' 个', 'warn');
        }
      } catch (err) {
        log('选取时出错：' + (err && err.message ? err.message : err), 'error');
        try { stopPicker(true); } catch (e2) { /* 忽略 */ }
      }
    };

    pickerMoveHandler = function (e) {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      if (el.closest && el.closest('#wb-auto-panel')) return;

      const doc = el.ownerDocument;
      const box = ensureHoverBox(doc);
      if (!box) return;

      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width < 1 || rect.height < 1) {
        box.style.display = 'none';
        return;
      }
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.display = 'block';
    };

    pickerKeyHandler = function (e) {
      if (e.key === 'Escape' && pickerActive) {
        stopPicker(true);
        if (IS_TOP) log('已取消选取');
      }
    };

    for (let i = 0; i < pickBoundDocs.length; i++) {
      const doc = pickBoundDocs[i];
      // pointerdown 先接：有些课件 preventDefault 掉了 click，只等 click 会永远等不到
      doc.addEventListener('pointerdown', pickerHandler, true);
      doc.addEventListener('mousedown', pickerHandler, true);
      doc.addEventListener('click', pickerHandler, true);
      doc.addEventListener('mousemove', pickerMoveHandler, true);
      doc.addEventListener('keydown', pickerKeyHandler, true);
    }

    if (IS_TOP) {
      log('选取模式已开启：点一下页面上要自动点的按钮（Esc 取消）');
      showPickTip(true);
      postToFrames({ wb: FRAME_MSG, action: 'pick-start', hop: 0 });
    }
    updatePickerLabel();
  }

  function stopPicker(notifyFrames) {
    pickerActive = false;

    for (let i = 0; i < pickBoundDocs.length; i++) {
      const doc = pickBoundDocs[i];
      try { doc.documentElement.style.cursor = ''; } catch (e) { /* 忽略 */ }
      if (pickerHandler) {
        doc.removeEventListener('pointerdown', pickerHandler, true);
        doc.removeEventListener('mousedown', pickerHandler, true);
        doc.removeEventListener('click', pickerHandler, true);
        doc.removeEventListener('mousemove', pickerMoveHandler, true);
        doc.removeEventListener('keydown', pickerKeyHandler, true);
      }
    }
    pickBoundDocs = [];
    pickerHandler = null;
    pickerMoveHandler = null;
    pickerKeyHandler = null;

    if (document.body) document.body.style.cursor = '';
    removePickUi();

    if (IS_TOP) {
      showPickTip(false);
      if (notifyFrames) postToFrames({ wb: FRAME_MSG, action: 'pick-stop' });
    }
    updatePickerLabel();
  }

  function listenFrameMessages() {
    window.addEventListener('message', function (e) {
      const data = e.data;
      if (!data || data.wb !== FRAME_MSG) return;

      if (data.action === 'pick-start') {
        if (IS_TOP) return;
        startPicker(true);
        if ((data.hop || 0) < 3) {
          postToFrames({ wb: FRAME_MSG, action: 'pick-start', hop: (data.hop || 0) + 1 });
        }
        return;
      }

      if (data.action === 'pick-stop') {
        if (!IS_TOP) stopPicker(false);
        return;
      }

      if (data.action === 'picked' && IS_TOP) {
        log('已记住元素：' + data.selector + '（来自课件 iframe）');
        updatePickerLabel();
        scheduleScan('iframe 选取完成', 300);
        return;
      }

      if (data.action === 'hello' && IS_TOP) {
        const host = String(data.host || '');
        const seen = FRAMES_SEEN.some(function (f) { return f.host === host; });
        if (!seen) {
          FRAMES_SEEN.push({ host: host, href: data.href || '' });
          log('课件帧里的脚本已生效：' + host + '（共 ' + FRAMES_SEEN.length + ' 个帧）');
        }
        return;
      }

      // 顶层/帧之间同步运行态：暂停必须让真正干活的那一帧也停下来
      if (data.action === 'running') {
        applyRunning(!!data.value, true);
        return;
      }

      if (data.action === 'config-sync') {
        CONFIG.quiz.enabled = !!data.quiz;
        CONFIG.interactive.enabled = !!data.interactive;
        lastConfigSyncAt = now();
        log('已同步父页面设置：答题' + (CONFIG.quiz.enabled ? '开' : '关') +
          ' / 互动' + (CONFIG.interactive.enabled ? '开' : '关'));
        scheduleScan('配置同步', 600);
        return;
      }

      if (data.action === 'captcha-on' && IS_TOP) {
        if (!state.captchaActive) {
          enterCaptchaMode({ selector: '课件帧 ' + (data.host || '') + ' 的安全验证' });
          log('课件帧里弹出了安全验证：请在页面上手动完成，帧内脚本已停手', 'warn');
        }
        return;
      }

      if (data.action === 'captcha-off' && IS_TOP) {
        if (state.captchaActive) exitCaptchaMode();
        return;
      }

      // 顶层用户点了「跳过等待」：帧内也照做，否则会一直停在验证态
      if (data.action === 'captcha-skip') {
        const allSel = CAPTCHA_FRAME_SELECTORS.concat(CAPTCHA_BOX_SELECTORS);
        for (let i = 0; i < allSel.length; i++) {
          const hit = queryAllDeep(allSel[i]).some(function (el) {
            return !inPanel(el) && isVisible(el);
          });
          if (hit) captchaSkip.add(allSel[i]);
        }
        captchaSkip.add('text');
        state.captchaActive = false;
        if (captchaTimer) { clearInterval(captchaTimer); captchaTimer = null; }
        stopTitleFlash();
        updateCaptchaBanner(false);
        log('已按顶层指令跳过验证等待，帧内恢复自动点击', 'warn');
        scheduleScan('跳过验证', 700);
        // 继续往下一层传
        postToFrames({ wb: FRAME_MSG, action: 'captcha-skip' });
        return;
      }

      if (data.action === 'reset-backoff') {
        if (!IS_TOP) {
          log('收到「继续」指令，已清空退避记录，立即重试');
          scheduleScan('父页面恢复', 500);
        }
        // 继续往下一层传，照顾"帧里还有帧"的课件
        postToFrames({ wb: FRAME_MSG, action: 'reset-backoff' });
        return;
      }

      if (data.action === 'report-request') {
        if (IS_TOP) return;
        try {
          postToTop({ wb: FRAME_MSG, action: 'report', host: location.hostname, lines: buildFrameLines() });
        } catch (err) { /* 忽略 */ }
        return;
      }

      if (data.action === 'report' && IS_TOP) {
        FRAME_REPORTS.push({ host: String(data.host || ''), lines: Array.isArray(data.lines) ? data.lines : [] });
        return;
      }

      if (data.action === 'status' && IS_TOP) {
        state.frameStatus = { text: String(data.text || ''), at: now(), host: data.host || '' };
        updatePanelState();
        return;
      }

      if (data.action === 'progress' && IS_TOP) {
        state.frameClicks++;
        state.lastAction = '课件帧内已点击「' + (data.text || '') + '」';
        updateStatusLine();
        return;
      }

      if (data.action === 'log' && IS_TOP) {
        log(data.msg, data.level);
      }

      if (data.action === 'ctx-fail') {
        // 这一帧的域名判定没过（课件域名五花八门、referrer 又常被抹掉）。
        // 我们是微伴页面，直接授权它启动 —— 从此不再依赖域名白名单。
        // 但要挡掉统计像素、客服挂件这类小尺寸帧，免得在无关小窗里也跑起来乱点
        if (!IS_TOP) return;

        const frameEl = frameElementFor(e.source);
        if (frameEl) {
          const rect = frameEl.getClientRects && frameEl.getClientRects()[0];
          if (!rect || rect.width < 320 || rect.height < 240) return;
        }

        try {
          if (e.source) e.source.postMessage({ wb: FRAME_MSG, action: 'activate' }, '*');
        } catch (err) { /* 忽略 */ }

        const host = String(data.host || '(未知域名)');
        if (FRAMES_ACTIVATED.indexOf(host) === -1) {
          FRAMES_ACTIVATED.push(host);
          log('课件帧 ' + host + ' 已由父页面放行并启动（不需要加域名白名单）');
        }
        return;
      }
    });
  }

  /* ==================================================================
   * 十六、AI 连接状态 / 自检 / 页面诊断
   * ================================================================== */
  const aiStatus = { kind: 'init', text: '未配置 Key' };

  function setAiStatus(kind, text) {
    aiStatus.kind = kind;
    aiStatus.text = text;
    renderAiStatus();
  }

  function testDeepSeek() {
    const key = getKey();
    if (!key) {
      setAiStatus('fail', '未配置 Key');
      log('请先在 AI 设置里填写 DeepSeek Key', 'warn');
      return;
    }

    setAiStatus('testing', '正在连接…');
    const startedAt = now();

    callDeepSeekRaw(key, [{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 8 })
      .then(function (res) {
        const cost = ((now() - startedAt) / 1000).toFixed(1);
        if (res.ok) {
          setAiStatus('ok', '已成功连接 · ' + cost + 's');
          log('DeepSeek 已成功连接（模型 ' + CONFIG.quiz.model + '，耗时 ' + cost + 's）');
        } else {
          setAiStatus('fail', res.message);
          log('DeepSeek 连接失败：' + res.message, 'warn');
        }
      });
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const id = el.getAttribute ? el.getAttribute('id') : '';
    const text = elementText(el).slice(0, 16);
    const rect = el.getClientRects && el.getClientRects()[0];
    const size = rect ? Math.round(rect.width) + '×' + Math.round(rect.height) : '0×0';
    return tag + (id ? '#' + id : '') + (cls.length ? '.' + cls.join('.') : '') + ' "' + text + '" ' + size;
  }

  function buildReport() {
    const lines = [];
    lines.push('=== 安全微伴自动挂机 · 页面诊断 v1.16.2 ===');
    lines.push('时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('URL：' + location.href);
    lines.push('标题：' + (document.title || '(空)'));
    lines.push('当前窗口：' + (IS_TOP ? '顶层' : 'iframe 内'));
    lines.push('运行：' + (state.running ? '运行中' : '已暂停') + '，已点击 ' + state.clickCount + ' 次');
    lines.push('AI：' + aiStatus.text);
    lines.push('AI 答题开关：' + (CONFIG.quiz.enabled ? '已开启' : '未开启（选择题不会作答）') +
      '，互动开关：' + (CONFIG.interactive.enabled ? '已开启' : '未开启'));
    lines.push('验证等待中：' + (state.captchaActive ? '是' : '否') +
      (state.captchaActive ? '（判定依据：' + (state.captchaSelector || 'unknown') + '）' : ''));
    if (captchaSkip.size) lines.push('已忽略的验证选择器：' + Array.from(captchaSkip).join(' | '));

    let frames = [];
    try { frames = document.querySelectorAll('iframe, frame'); } catch (e) { frames = []; }
    lines.push('iframe 数量：' + frames.length);
    for (let i = 0; i < frames.length; i++) {
      let src = '(无 src)';
      try { src = frames[i].src || frames[i].getAttribute('src') || '(无 src)'; } catch (e) { /* 忽略 */ }
      let accessible = false;
      try { accessible = !!frames[i].contentDocument; } catch (e) { accessible = false; }
      let injected = false;
      try {
        const host = new URL(src, location.href).hostname;
        injected = FRAMES_SEEN.some(function (f) { return f.host === host; });
      } catch (e) { injected = false; }
      lines.push('  iframe[' + i + '] ' + src + ' ｜ ' +
        (accessible ? '同源可读' : '跨域不可读') +
        ' ｜ 帧内脚本：' + (injected ? '已生效' : '未检测到'));
    }
    lines.push('报到的帧：' + (FRAMES_SEEN.length
      ? FRAMES_SEEN.map(function (f) { return f.host; }).join(' | ')
      : '无（若上面有 iframe，说明脚本没进到那一帧）'));

    lines.push('自定义选择器：' + (getCustomSelectors().join(' | ') || '无'));
    lines.push('连续零候选次数：' + state.zeroScans);
    lines.push('累计点击：' + state.clickCount + ' 次（帧内 ' + state.frameClicks + ' 次）');
    lines.push('停顿时：' + (state.resting ? '是（还有 ' + Math.max(0, Math.ceil((state.restUntil - now()) / 1000)) + ' 秒）' : '否'));
    lines.push('页面内相关文字：' + probeNextButtons());

    lines.push('帧内点击汇总：' + state.frameClicks + ' 次');
    if (state.frameStatus && state.frameStatus.text) {
      lines.push('帧内最近状态：' + state.frameStatus.text +
        '（' + Math.max(0, Math.round((now() - state.frameStatus.at) / 1000)) + ' 秒前）');
    }
    if (FRAME_REPORTS.length) {
      for (let i = 0; i < FRAME_REPORTS.length; i++) {
        const rep = FRAME_REPORTS[i];
        for (let j = 0; j < rep.lines.length; j++) lines.push(rep.lines[j]);
      }
    } else if (frames.length) {
      lines.push('（课件帧没有回传诊断：可能是脚本还没在那一帧启动，刷新页面再点一次）');
    }

    const cards = collectCardCandidates();
    lines.push('课程卡片候选：' + cards.length + ' 张' +
      (cards.length ? '（第一张：' + cards[0].text.slice(0, 20) + '）' : ''));

    const nodes = queryAllDeep(CANDIDATE_SELECTOR);
    const visible = [];
    for (let i = 0; i < nodes.length && visible.length < 12; i++) {
      if (inPanel(nodes[i]) || !isVisible(nodes[i])) continue;
      visible.push(describeElement(nodes[i]));
    }
    lines.push('可见可点元素（最多 12 个）：');
    if (!visible.length) lines.push('  （没有）');
    visible.forEach(function (item) { lines.push('  ' + item); });

    const scene = captureScene();
    lines.push('互动区：' + (scene ? scene.kind + '，元素 ' + scene.nodes.length + ' 个' : '未识别到'));
    return lines.join('\n');
  }

  /**
   * 帧内的精简诊断：顶层看不到这里面的任何东西，
   * 只有把这些行拼进报告，才能判断"为什么帧内不动"。
   */
  function buildFrameLines() {
    const lines = [];
    lines.push('—— 课件帧 ' + location.hostname + ' ——');
    lines.push('  帧 URL：' + String(location.href).slice(0, 160));
    lines.push('  帧内状态：' + (state.lastAction || '(空)'));
    lines.push('  帧内点击：' + state.clickCount + ' 次，连续点击未休息：' + state.sinceRest +
      '，停顿时：' + (state.resting ? '是' : '否'));
    lines.push('  帧内运行：' + (state.running ? '运行中' : '已暂停') +
      '，AI 答题：' + (CONFIG.quiz.enabled ? '开' : '关') +
      '，互动：' + (CONFIG.interactive.enabled ? '开' : '关'));

    let cands = [];
    try { cands = collectCandidates(); } catch (e) { cands = []; }
    lines.push('  帧内候选：' + cands.length + ' 个' +
      (cands.length ? '（' + cands[0].rule.name + '：' + String(cands[0].text).slice(0, 20) + '）' : ''));

    let quiz = null;
    try { quiz = findQuiz(); } catch (e) { quiz = null; }
    if (quiz) {
      lines.push('  帧内题目：识别到（' + (quiz.type || '未知题型') + '，选项 ' +
        (quiz.options ? quiz.options.length : 0) + ' 个；题干：' +
        String(quiz.stem || '').slice(0, 40) + '）');
    } else {
      try {
      const imgOpts = queryAllDeep('[class*="btn-aq-item"]').filter(function (el) { return !inPanel(el) && isVisible(el); });
      if (imgOpts.length) lines.push('  帧内图片选项按钮：' + imgOpts.length + ' 个（走全选）');
    } catch (e5) { /* 忽略 */ }

    lines.push('  帧内题目：未识别到' +
        (looksLikeQuizPage() ? '（但页面文字像答题页）' : ''));
    }

    // 把"以 A/B/C 开头的可见块"列出来：这是判断选项识别为什么失败的第一手证据
    try {
      const probe = [];
      const nodes = queryAllDeep('div,p,li,span,a,section,td');
      for (let i = 0; i < nodes.length && probe.length < 6; i++) {
        const el = nodes[i];
        if (inPanel(el) || !isVisible(el)) continue;
        const t = elementText(el);
        if (!t || !/^[A-Ha-h]\s*[.、．:：)）]?\s*[\u4e00-\u9fa5]/.test(t)) continue;
        const r = el.getClientRects ? el.getClientRects()[0] : null;
        const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
        probe.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') +
          '[' + (r ? Math.round(r.width) + 'x' + Math.round(r.height) : '0') + ']' +
          ' "' + t.slice(0, 14) + '"');
      }
      lines.push('  帧内字母块：' + (probe.length ? probe.join(' / ') : '无'));
    } catch (e2) { /* 忽略 */ }

    lines.push('  帧内相关文字：' + probeNextButtons());
    lines.push('  帧内验证等待：' + (state.captchaActive ? '是（' + state.captchaSelector + '）' : '否'));

    // 当前这一页到底长什么样：文字总量 + 子帧 + 面积最大的可见元素
    // （题目若在更深一层 iframe、或是图片/canvas，靠这几行立刻能看出来）
    let bodyText = '';
    try { bodyText = pageTextWithoutPanel(); } catch (e) { bodyText = ''; }
    lines.push('  帧内正文：' + bodyText.length + ' 字，开头：' +
      String(bodyText).replace(/\s+/g, ' ').slice(0, 70));

    let subFrames = 0;
    let subCross = 0;
    try {
      const nodes = document.querySelectorAll('iframe, frame');
      subFrames = nodes.length;
      for (let i = 0; i < nodes.length; i++) {
        let ok = false;
        try { ok = !!nodes[i].contentDocument; } catch (e) { ok = false; }
        if (!ok) subCross++;
      }
    } catch (e) { /* 忽略 */ }
    lines.push('  帧内子帧：' + subFrames + ' 个' + (subCross ? '（其中跨域 ' + subCross + ' 个，里面的东西同样读不到）' : ''));

    try {
      const all = queryAllDeep('div,a,img,section,p,span,button,li,canvas');
      const snap = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (inPanel(el) || !isVisible(el)) continue;
        const r = el.getClientRects ? el.getClientRects()[0] : null;
        if (!r) continue;
        const area = r.width * r.height;
        if (area < 1500) continue;
        snap.push({ el: el, r: r, area: area });
      }
      snap.sort(function (a, b) { return b.area - a.area; });
      lines.push('  帧内结构快照（按面积前 10）：');
      for (let i = 0; i < snap.length && i < 10; i++) {
        const el = snap[i].el;
        const r = snap[i].r;
        const cls = typeof el.className === 'string'
          ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const t = elementText(el).replace(/\s+/g, ' ').slice(0, 24);
        let extra = '';
        if (el.tagName === 'IMG') extra += ' img:' + String(el.getAttribute('src') || '').split('/').pop().slice(0, 24);
        if (el.tagName === 'CANVAS') extra += ' canvas';
        try {
          const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
          if (style && style.backgroundImage && style.backgroundImage !== 'none') extra += ' bg图';
        } catch (e2) { /* 忽略 */ }
        lines.push('    ' + el.tagName.toLowerCase() + (cls ? '.' + cls : '') +
          '[' + Math.round(r.width) + 'x' + Math.round(r.height) + ']@' +
          Math.round(r.left) + ',' + Math.round(r.top) +
          (t ? ' "' + t + '"' : '') + extra);
      }
    } catch (e3) { /* 忽略 */ }

    const customs = getCustomSelectors();
    if (customs.length) lines.push('  帧内自定义选择器：' + customs.join(' | '));
    return lines;
  }

  /** 顶层：请所有帧把自己的诊断发上来 */
  function requestFrameReports() {
    FRAME_REPORTS = [];
    let frames = [];
    try { frames = document.querySelectorAll('iframe, frame'); } catch (e) { frames = []; }
    if (!frames.length) return 0;
    postToFrames({ wb: FRAME_MSG, action: 'report-request' });
    return frames.length;
  }

  function copyReport() {
    const frameCount = requestFrameReports();
    if (frameCount) log('正在收集课件帧内的诊断信息…');
    if (frameCount) showReportWaiting(true);

    // 帧内是异步回话的，等一下再生成最终报告
    setTimeout(function () {
      if (frameCount) showReportWaiting(false);
      const text = buildReport();
      console.log(text);
      log('诊断报告已输出到控制台' + (FRAME_REPORTS.length
        ? '（含 ' + FRAME_REPORTS.length + ' 个课件帧）'
        : ''));

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          log('诊断报告已复制到剪贴板');
        }).catch(function () {
          log('复制失败，请到 F12 控制台手动复制', 'warn');
        });
      }
    }, frameCount ? 900 : 0);
  }

  function showReportWaiting(show) {
    if (!panelEl) return;
    const btn = panelEl.querySelector('#wb-report');
    if (btn) btn.textContent = show ? '收集中…' : '扫描诊断';
  }

  /* ==================================================================
   * 十七、面板
   * ================================================================== */
  let panelEl = null;
  let statusEl = null;
  let actionEl = null;
  let logEl = null;
  let toggleBtn = null;
  let collapsed = false;

  function buildPanel() {
    if (!IS_TOP) return;
    if (!document.body || document.getElementById('wb-auto-panel')) return;

    panelEl = document.createElement('div');
    panelEl.id = 'wb-auto-panel';
    panelEl.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:268px', 'box-sizing:border-box', 'padding:10px 12px',
      'background:rgba(28,32,42,0.94)', 'color:#e8ecf3',
      'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'border:1px solid rgba(255,255,255,0.12)', 'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)', 'user-select:none'
    ].join(';');

    panelEl.innerHTML = [
      '<div id="wb-hd" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">',
      '  <span style="font-weight:500;font-size:12.5px;">安全微伴 · 自动挂机 <span style="opacity:.5;">v1.16.2</span></span>',
      '  <span id="wb-fold" style="opacity:.7;">收起</span>',
      '</div>',
      '<div id="wb-body" style="margin-top:8px;">',
      '  <div id="wb-status" style="color:#8fe388;">自动点击运行中</div>',
      '  <div id="wb-action" style="color:#a9b4c6;margin-top:2px;word-break:break-all;">准备中…</div>',
      '  <div id="wb-next" style="color:#7b879b;margin-top:2px;">下次检查：--</div>',
      '  <div id="wb-ai-badge" style="color:#7b879b;margin-top:2px;">AI：未配置 Key</div>',
      '  <div style="display:flex;gap:6px;margin-top:8px;">',
      '    <button id="wb-toggle" type="button" style="flex:1;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#e8ecf3;cursor:pointer;font-size:12px;">暂停</button>',
      '    <button id="wb-quiz" type="button" style="flex:1;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#e8ecf3;cursor:pointer;font-size:12px;">AI 设置</button>',
      '  </div>',
      '  <div style="display:flex;gap:6px;margin-top:6px;">',
      '    <button id="wb-pick" type="button" style="flex:1;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#e8ecf3;cursor:pointer;font-size:12px;">选取元素</button>',
      '    <button id="wb-report" type="button" style="flex:1;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#e8ecf3;cursor:pointer;font-size:12px;">扫描诊断</button>',
      '  </div>',
      '  <div id="wb-pick-tip" style="display:none;margin-top:6px;padding:5px 8px;border-radius:6px;background:rgba(232,192,125,0.16);border:1px solid rgba(232,192,125,0.5);color:#f0d29a;">',
      '    选取中：点一下页面上要自动点的按钮<br><span style="opacity:.75;">再点「取消选取」或按 Esc 退出</span>',
      '  </div>',
      '  <div id="wb-captcha-tip" style="display:none;margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(240,138,138,0.16);border:1px solid rgba(240,138,138,0.55);color:#f6c0c0;">',
      '    检测到安全验证：请在页面上完成<br><span style="opacity:.8;">完成后自动继续；若页面其实没有验证码，点「跳过等待」</span>',
      '  </div>',
      '  <div id="wb-quiz-box" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,0.15);">',
      '    <div style="color:#a9b4c6;">DeepSeek API Key（只存本机）</div>',
      '    <input id="wb-key" type="password" placeholder="sk-..." style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.35);color:#e8ecf3;font-size:12px;outline:none;">',
      '    <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">',
      '      <button id="wb-test" type="button" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(143,227,136,0.4);background:rgba(143,227,136,0.12);color:#c8f3c3;cursor:pointer;font-size:12px;">测试连接</button>',
      '      <span id="wb-ai-status" style="color:#7b879b;">未测试</span>',
      '    </div>',
      '    <label style="display:flex;align-items:center;gap:6px;margin-top:6px;color:#a9b4c6;cursor:pointer;">',
      '      <input id="wb-quiz-enable" type="checkbox" style="margin:0;">启用 AI 自动答题（选择题）',
      '    </label>',
      '    <label style="display:flex;align-items:center;gap:6px;margin-top:4px;color:#a9b4c6;cursor:pointer;">',
      '      <input id="wb-game-enable" type="checkbox" style="margin:0;">启用 AI 互动任务（小游戏）',
      '    </label>',
      '    <button id="wb-key-save" type="button" style="width:100%;margin-top:6px;padding:4px 0;border-radius:6px;border:1px solid rgba(143,227,136,0.4);background:rgba(143,227,136,0.15);color:#c8f3c3;cursor:pointer;font-size:12px;">保存</button>',
      '    <button id="wb-clear" type="button" style="width:100%;margin-top:6px;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#a9b4c6;cursor:pointer;font-size:12px;">清空「选取元素」记录</button>',
      '  </div>',
      '  <div id="wb-log" style="margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.15);color:#7b879b;max-height:74px;overflow:hidden;"></div>',
      '</div>'
    ].join('');

    document.body.appendChild(panelEl);

    statusEl = panelEl.querySelector('#wb-status');
    actionEl = panelEl.querySelector('#wb-action');
    logEl = panelEl.querySelector('#wb-log');
    toggleBtn = panelEl.querySelector('#wb-toggle');

    panelEl.querySelector('#wb-hd').addEventListener('click', function () {
      collapsed = !collapsed;
      panelEl.querySelector('#wb-body').style.display = collapsed ? 'none' : 'block';
      panelEl.querySelector('#wb-fold').textContent = collapsed ? '展开' : '收起';
      panelEl.style.width = collapsed ? '170px' : '268px';
    });

    toggleBtn.addEventListener('click', function () {
      // 等待验证时，这个按钮就是"误判逃生阀"
      if (state.captchaActive) {
        setRunning(true);
        return;
      }
      // 长休息时，点一下就是"跳过休息"，不用等
      if (state.resting && state.running) {
        state.resting = false;
        state.restUntil = 0;
        log('已手动跳过停顿，立即继续');
        scheduleScan('跳过休息', 300);
        updatePanelState();
        return;
      }
      setRunning(!state.running);
    });

    const quizBox = panelEl.querySelector('#wb-quiz-box');
    const keyInput = panelEl.querySelector('#wb-key');
    const quizEnable = panelEl.querySelector('#wb-quiz-enable');
    const gameEnable = panelEl.querySelector('#wb-game-enable');

    panelEl.querySelector('#wb-quiz').addEventListener('click', function () {
      const open = quizBox.style.display !== 'none';
      quizBox.style.display = open ? 'none' : 'block';
    });

    panelEl.querySelector('#wb-pick').addEventListener('click', function () {
      startPicker(false);
    });

    panelEl.querySelector('#wb-report').addEventListener('click', function () {
      copyReport();
    });

    panelEl.querySelector('#wb-test').addEventListener('click', function () {
      // 测试前先把输入框里的 Key 存下来，避免用户没点保存就测
      const typed = keyInput.value.trim();
      if (typed) Store.set('deepseek_key', typed);
      testDeepSeek();
    });

    panelEl.querySelector('#wb-clear').addEventListener('click', function () {
      clearCustomSelectors();
      log('已清空自定义元素记录');
      updatePickerLabel();
    });

    keyInput.value = getKey();
    quizEnable.checked = !!Store.get('quiz_enabled', CONFIG.quiz.enabled);
    gameEnable.checked = !!Store.get('interactive_enabled', CONFIG.interactive.enabled);

    panelEl.querySelector('#wb-key-save').addEventListener('click', function () {
      Store.set('deepseek_key', keyInput.value.trim());
      Store.set('quiz_enabled', !!quizEnable.checked);
      Store.set('interactive_enabled', !!gameEnable.checked);
      CONFIG.quiz.enabled = !!quizEnable.checked;
      CONFIG.interactive.enabled = !!gameEnable.checked;

      // 关键：真正答题的是课件帧，它启动时读的是当时的开关。
      // 不同步过去的话，会出现"面板显示已开启、帧内却是关"的诡异状态
      postToFrames({
        wb: FRAME_MSG, action: 'config-sync',
        quiz: !!quizEnable.checked, interactive: !!gameEnable.checked,
        key: keyInput.value.trim()
      });

      log('AI 设置已保存：答题' + (quizEnable.checked ? '开' : '关') +
        ' / 互动任务' + (gameEnable.checked ? '开' : '关') + '（已同步给课件帧）');
      updateStatusLine();

      const key = getKey();
      if (key) {
        setAiStatus('unknown', '已填写，正在检测…');
        testDeepSeek();
      } else {
        setAiStatus('init', '未配置 Key');
      }
    });

    updatePanelState();
    updateStatusLine();
    updatePickerLabel();
    renderAiStatus();
    renderLogs();
    startUiTicker();
  }

  function showPickTip(show) {
    if (!panelEl) return;
    const tip = panelEl.querySelector('#wb-pick-tip');
    if (tip) tip.style.display = show ? 'block' : 'none';
  }

  function renderLogs() {
    if (!logEl) return;
    logEl.innerHTML = LOGS.slice(-3).map(function (l) {
      const color = l.level === 'warn' ? '#e8c07d' : (l.level === 'error' ? '#f08a8a' : '#7b879b');
      return '<div style="color:' + color + ';">' + escapeHtml(l.time + ' ' + l.msg) + '</div>';
    }).join('');
  }

  function renderAiStatus() {
    if (!panelEl) return;
    const color = aiStatus.kind === 'ok' ? '#8fe388'
      : (aiStatus.kind === 'fail' ? '#f08a8a' : (aiStatus.kind === 'testing' ? '#e8c07d' : '#7b879b'));

    const badge = panelEl.querySelector('#wb-ai-badge');
    if (badge) {
      badge.style.color = color;
      badge.textContent = 'AI：' + aiStatus.text;
    }
    const line = panelEl.querySelector('#wb-ai-status');
    if (line) {
      line.style.color = color;
      line.textContent = aiStatus.text;
    }
  }

  function updatePanelState() {
    if (!panelEl) return;
    if (statusEl) {
      if (state.captchaActive) {
        statusEl.textContent = '已暂停：等待你完成安全验证';
        statusEl.style.color = '#f08a8a';
      } else if (state.resting && state.running) {
        const leftS = Math.max(0, Math.ceil((state.restUntil - now()) / 1000));
        statusEl.textContent = '短暂停顿 · 还有 ' + leftS + ' 秒（模拟人工节奏）';
        statusEl.style.color = '#e8c07d';
      } else {
        statusEl.textContent = state.running ? '自动点击运行中' : '已暂停';
        statusEl.style.color = state.running ? '#8fe388' : '#e8c07d';
      }
    }
    if (toggleBtn) {
      if (state.captchaActive) toggleBtn.textContent = '跳过等待';
      else if (state.resting && state.running) toggleBtn.textContent = '跳过休息';
      else toggleBtn.textContent = state.running ? '暂停' : '继续';
    }
    if (actionEl) {
      // 真正干活的是课件帧，它的状态比顶层"暂无可点元素"更有信息量
      const fs = state.frameStatus;
      const frameFresh = !!(fs && fs.text && now() - fs.at < 20000);
      const head = frameFresh ? '课件帧：' + fs.text : state.lastAction;
      actionEl.textContent = head + ' ｜ 已点击 ' + state.clickCount + ' 次' +
        (state.frameClicks ? '（帧内 ' + state.frameClicks + '）' : '') +
        (CONFIG.interactive.enabled ? ' ｜ 互动 ' + gameAgent.actions + ' 次' : '');
    }
  }

  let lastConfigSyncAt = 0;

  /**
   * 课件帧兜底：定时重读一次设置。
   * 万一 config-sync 消息没收到（帧刚重建、消息早于监听注册），也能自己对齐，
   * 不至于出现"面板开了答题、帧内一直关着"。
   */
  function syncConfigFromStore() {
    if (IS_TOP) return;
    if (now() - lastConfigSyncAt < 15000) return;
    lastConfigSyncAt = now();

    const q = Store.get('quiz_enabled', null);
    const g = Store.get('interactive_enabled', null);
    if (q != null && !!q !== CONFIG.quiz.enabled) {
      CONFIG.quiz.enabled = !!q;
      log('帧内答题开关已按本机设置校正为：' + (q ? '开' : '关'));
    }
    if (g != null && !!g !== CONFIG.interactive.enabled) {
      CONFIG.interactive.enabled = !!g;
    }
  }

  let lastSharedText = '';
  let lastSharedAt = 0;

  /**
   * 课件帧里没有面板，用户只能看到顶层"本页暂无可点元素"，
   * 完全不知道帧内到底在干什么。这里把帧内的状态文字回传给顶层显示。
   */
  function shareStatus() {
    if (IS_TOP) return;
    const text = state.lastAction || '';
    if (!text || text === lastSharedText) return;
    if (now() - lastSharedAt < 1200) return;

    lastSharedText = text;
    lastSharedAt = now();
    postToTop({
      wb: FRAME_MSG, action: 'status', host: location.hostname,
      text: text, clicks: state.clickCount
    });
  }

  function updateStatusLine() {
    shareStatus();
    updatePanelState();
  }

  function updatePickerLabel() {
    if (!panelEl) return;
    const btn = panelEl.querySelector('#wb-pick');
    if (!btn) return;
    const count = getCustomSelectors().length;
    btn.textContent = pickerActive ? '取消选取' : ('选取元素' + (count ? '(' + count + ')' : ''));
    btn.style.borderColor = pickerActive ? 'rgba(232,192,125,0.85)' : 'rgba(255,255,255,0.18)';
    btn.style.color = pickerActive ? '#f0d29a' : '#e8ecf3';
  }

  function startUiTicker() {
    if (uiTimer) clearInterval(uiTimer);
    uiTimer = setInterval(function () {
      if (!panelEl) return;
      const nextEl = panelEl.querySelector('#wb-next');
      if (!nextEl) return;
      if (!state.running) { nextEl.textContent = '下次检查：已暂停'; return; }
      if (state.resting) {
        const restLeft = Math.max(0, Math.ceil((state.restUntil - now()) / 1000));
        nextEl.textContent = '停顿：' + restLeft + 's 后继续（点按钮可跳过）';
        return;
      }
      if (clickTimer) { nextEl.textContent = '下次检查：正在执行点击…'; return; }
      if (state.captchaActive) { nextEl.textContent = '下次检查：等待验证完成'; return; }
      if (pickerActive) { nextEl.textContent = '下次检查：选取模式暂停中'; return; }
      const left = Math.max(0, Math.ceil((state.nextScanAt - now()) / 1000));
      // 休息期间始终明说"长休息"，否则剩 50 秒时会显示成"下次检查：50s"，看着像卡住
      if (state.resting) nextEl.textContent = '停顿：' + left + 's 后继续（点按钮可跳过）';
      else nextEl.textContent = '下次检查：' + left + 's';
    }, 500);
  }

  /* ==================================================================
   * 十八、启动
   * ================================================================== */
  function bootstrap() {
    CONFIG.quiz.enabled = !!Store.get('quiz_enabled', CONFIG.quiz.enabled);
    CONFIG.interactive.enabled = !!Store.get('interactive_enabled', CONFIG.interactive.enabled);

    listenFrameMessages();
    hookHistory();
    hookWindowOpen();
    announceFrame();

    // 有些 iframe 是页面脚本后来才插进来的，启动后持续喊一阵，确保每一帧都能被放行
    broadcastActivate();

    // 快速判定：跨域课件帧到底活没活。3 秒就有结论，不用等一分钟
    if (IS_TOP) {
      setTimeout(function () {
        if (!hasCrossFrame()) return;
        if (FRAMES_SEEN.length || FRAMES_ACTIVATED.length) return;
        log('检测到跨域 iframe，但 3 秒内没收到帧内脚本的回应：多半是油猴没注入到子帧。' +
          '先刷新页面；仍不行就检查脚本没有勾 @noframes、且 Tampermonkey 处于开启状态', 'error');
      }, 3000);
    }

    let activateTries = 0;
    const activateTimer = setInterval(function () {
      if (activateTries++ > 9) { clearInterval(activateTimer); return; }
      broadcastActivate();
    }, 2000);

    buildPanel();
    observeDom();

    // 真正操作课件的是这一帧，和顶层一样保持 1-2 秒
    if (!IS_TOP) {
      CONFIG.scan.minInterval = 900;
      CONFIG.scan.maxInterval = 1600;
      CONFIG.scan.idleMinInterval = 600;
      CONFIG.scan.idleMaxInterval = 1100;
    }

    log('脚本已启动（' + (IS_TOP ? '顶层' : 'iframe 内') + '），轮询 ' +
      CONFIG.scan.minInterval / 1000 + '-' + CONFIG.scan.maxInterval / 1000 + ' 秒' +
      (IS_TOP ? '' : '（课件帧用更快的节奏：真正要操作的是这里）'));

    // 已经填过 Key 的，启动就自动验一次，用户不用点按钮也能看到"已成功连接"
    if (getKey()) {
      setAiStatus('unknown', '已填写，正在检测…');
      setTimeout(testDeepSeek, 1200);
    } else {
      setAiStatus('init', '未配置 Key');
    }

    scheduleScan('启动', CONFIG.scan.firstDelay);
    startWatchdog();
  }

  window.__WB_AUTO = {
    version: '1.16.2',
    config: CONFIG,
    state: state,
    aiStatus: aiStatus,
    scanNow: function () { scan('手动'); },
    pause: function () { setRunning(false); },
    resume: function () { setRunning(true); },
    applyRunning: applyRunning,
    findQuiz: findQuiz,
    findImageQuiz: findImageQuiz,
    imageCombos: imageCombos,
    findQuestionImage: findQuestionImage,
    findResultContinue: findResultContinue,
    imageToBase64: imageToBase64,
    askVision: askVision,
    clickImagePoint: clickImagePoint,
    askWhereToClick: askWhereToClick,
    maybeAiFindClick: maybeAiFindClick,
    pickAnswerWithHistory: pickAnswerWithHistory,
    imageQuizKey: imageQuizKey,
    buildSelector: buildSelector,
    startPicker: startPicker,
    testDeepSeek: testDeepSeek,
    buildReport: buildReport,
    saveCustomSelector: saveCustomSelector,
    getCustomSelectors: getCustomSelectors,
    detectCaptcha: detectCaptcha,
    probeNextButtons: probeNextButtons,
    collectTextButtonCandidates: collectTextButtonCandidates,
    findLetterRowQuiz: findLetterRowQuiz,
    findInlineLetterQuiz: findInlineLetterQuiz,
    findAnyLetterQuiz: findAnyLetterQuiz,
    resolveOptionRow: resolveOptionRow,
    collectCardCandidates: collectCardCandidates,
    clickableLike: clickableLike,
    looksLikeQuizPage: looksLikeQuizPage,
    optionSignature: optionSignature,
    hasJudgePair: hasJudgePair,
    startWatchdog: startWatchdog,
    watchdogTick: watchdogTick,
    inWeibanContext: inWeibanContext,
    hasCrossFrame: hasCrossFrame,
    describeDocs: describeDocs,
    skipRest: function () { state.resting = false; state.restUntil = 0; },
    collectRoots: collectRoots,
    captureScene: captureScene,
    tickInteractive: tickInteractive,
    gameAgent: gameAgent,
    pickTarget: pickTarget,
    hookWindowOpen: hookWindowOpen
  };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
      bootstrap();
    }
  }   // ← main() 结束
})();
