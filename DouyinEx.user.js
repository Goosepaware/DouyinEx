// ==UserScript==
// @name         抖音直播增强 | DouyinEx
// @namespace    local.douyinex
// @version      0.3.0
// @description  画面弹幕悬停 +1 / 复制、屏蔽礼物/进场消息、进房自动最高画质、隐藏底部礼物栏
// @author       DouyinEx
// @match        *://live.douyin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 防止同一页面被重复注入
    try {
        if (window.__DouyinEx && window.__DouyinEx.__loaded) return;
    } catch (e) {
    }

    const VERSION = '0.3.0';
    const STORE_KEY = 'DouyinEx.settings.v1';
    const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
    const QUALITY_RANKS = ['原画', '蓝光', '超清', '高清', '标清', '流畅'];
    const LOCK_TEXT_RE = /登录即享|请先登录|请先登陆|扫码|开通/;
    const LOCK_STRIP_RE = /登录即享|请先登录|请先登陆|扫码|开通/g;

    const SEL = {
        chatList: '.webcast-chatroom___list',
        chatItem: '.webcast-chatroom___item-wrapper',
        username: '.v8LY0gZF, [class*="webcast-chatroom___nickname"]',
        content: '.webcast-chatroom___content-with-emoji-text',
        qualityLabel: '[data-e2e="quality"]',
        qualityList: '[data-e2e="quality-selector"]',
        inputContainer: '.webcast-chatroom___input-container',
        inputCandidates: [
            '.webcast-chatroom___textarea',
            '.webcast-chatroom___input-container [contenteditable="true"]',
            '.webcast-chatroom___input-container textarea',
            '.webcast-chatroom___input-container input:not([type="search"])',
            '.webcast-chatroom___input-wrap textarea',
            '[data-e2e="room-chat-input"]',
            '[data-e2e="chat-input"]'
        ],
        sendBtnCandidates: [
            '.webcast-chatroom___send-btn',
            '.webcast-chatroom___enter',
            '[data-e2e="send-btn"]',
            '[data-e2e="chat-send-btn"]'
        ]
    };

    const SCREEN_CHANNEL = '__douyinex_screen_danmaku_v1__';

    // 画面弹幕由 CanvasDanmakuPlugin 画在 OffscreenCanvas 上、worker 渲染，主线程拿不到文本。
    // 在站点创建 worker 的 Blob 末尾注入补丁，hook fillText/strokeText 后经 BroadcastChannel 回传。
    const SCREEN_WORKER_PATCH = `
;try{
var __dxCh = new BroadcastChannel(${JSON.stringify(SCREEN_CHANNEL)});
var __dxProto = typeof OffscreenCanvasRenderingContext2D !== 'undefined' && OffscreenCanvasRenderingContext2D.prototype;
if (__dxProto) {
    var __dxFill = __dxProto.fillText;
    var __dxStroke = __dxProto.strokeText;
    var __dxClear = __dxProto.clearRect;
    var __dxCtxs = [];
    var __dxTimer = 0;
    var __dxReportOn = true;
    var __dxPin = null;
    var __dxPinCtx = null;
    var __dxPinFont = '';
    var __dxPinFill = null;
    var __dxPinStroke = null;
    var __dxPinLine = 0;
    var __dxPinHasStroke = false;

    function __dxArr(ctx) {
        for (var i = 0; i < __dxCtxs.length; i++) {
            if (__dxCtxs[i].c === ctx) return __dxCtxs[i].a;
        }
        var arr = [];
        __dxCtxs.push({ c: ctx, a: arr });
        return arr;
    }
    function __dxReport(ctx, txt, x, y, font) {
        if (!__dxReportOn) return;
        var cv = ctx.canvas || null;
        var w = 0;
        try { w = ctx.measureText(txt).width || 0; } catch (e) {}
        __dxArr(ctx).push([txt, x, y, font || '', (cv && cv.width) || 0, (cv && cv.height) || 0, w]);
        if (!__dxTimer) __dxTimer = setTimeout(__dxFlush, 0);
    }
    var __dxFlush = function () {
        __dxTimer = 0;
        var out = [];
        for (var i = 0; i < __dxCtxs.length; i++) {
            var a = __dxCtxs[i].a;
            for (var j = 0; j < a.length; j++) out.push(a[j]);
            a.length = 0;
        }
        if (out.length) {
            try { __dxCh.postMessage({ k: 'f', items: out }); } catch (e) {}
        }
    };
    function __dxSizeOk(ctx) {
        if (!__dxPin || !__dxPin.cw || !__dxPin.ch) return true;
        var cv = ctx.canvas;
        return !cv || (cv.width === __dxPin.cw && cv.height === __dxPin.ch);
    }
    function __dxFontOk(ctx) {
        if (!__dxPin || !__dxPin.font) return true;
        return !ctx.font || ctx.font === __dxPin.font;
    }
    function __dxShouldPin(ctx, txt, x, y) {
        if (!__dxPin || txt !== __dxPin.t) return false;
        if (!__dxSizeOk(ctx) || !__dxFontOk(ctx)) return false;
        if (Math.abs(y - __dxPin.y) > Math.max(2, (__dxPin.size || 16) * 0.45)) return false;
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (__dxPin.lastAt) {
            var dt = Math.max(0, now - __dxPin.lastAt);
            var expected = __dxPin.lastX + (__dxPin.speed || 0) * dt;
            var tolerance = Math.max(80, __dxPin.w || 0);
            if (Math.abs(x - expected) > tolerance) return false;
            if (dt > 0) {
                var speed = (x - __dxPin.lastX) / dt;
                if (isFinite(speed)) __dxPin.speed = speed;
            }
        }
        __dxPin.lastX = x;
        __dxPin.lastAt = now;
        return true;
    }

    __dxProto.fillText = function (t, x, y, m) {
        var txt = String(t);
        var pinned = false;
        try { pinned = __dxShouldPin(this, txt, x, y); } catch (e) {}
        if (pinned) {
            try {
                __dxPinCtx = this;
                __dxPinFont = this.font;
                __dxPinFill = this.fillStyle;
            } catch (e) {}
            try { __dxFill.call(this, txt, __dxPin.x, __dxPin.y, m); }
            catch (e) { try { __dxFill.call(this, txt, __dxPin.x, __dxPin.y); } catch (_) {} }
            try { __dxReport(this, txt, __dxPin.x, __dxPin.y, this.font); } catch (e) {}
            return;
        }
        __dxFill.call(this, txt, x, y, m);
        try { __dxReport(this, txt, x, y, this.font); } catch (e) {}
    };

    __dxProto.strokeText = function (t, x, y, m) {
        var txt = String(t);
        try {
            if (__dxShouldPin(this, txt, x, y)) {
                __dxPinCtx = this;
                __dxPinFont = this.font;
                __dxPinStroke = this.strokeStyle;
                __dxPinLine = this.lineWidth;
                __dxPinHasStroke = true;
                __dxStroke.call(this, txt, __dxPin.x, __dxPin.y, m);
                return;
            }
        } catch (e) {}
        __dxStroke.call(this, txt, x, y, m);
    };

    __dxProto.clearRect = function () {
        try { __dxArr(this).length = 0; } catch (e) {}
        var result = __dxClear.apply(this, arguments);
        try {
            if (__dxPin && __dxPinCtx === this) {
                this.save();
                if (__dxPinFont) this.font = __dxPinFont;
                if (__dxPinHasStroke) {
                    if (__dxPinStroke) this.strokeStyle = __dxPinStroke;
                    if (__dxPinLine) this.lineWidth = __dxPinLine;
                    try { __dxStroke.call(this, __dxPin.t, __dxPin.x, __dxPin.y); } catch (e) {}
                }
                if (__dxPinFill) this.fillStyle = __dxPinFill;
                __dxFill.call(this, __dxPin.t, __dxPin.x, __dxPin.y);
                this.restore();
                try { __dxReport(this, __dxPin.t, __dxPin.x, __dxPin.y, __dxPinFont); } catch (e) {}
            }
        } catch (e) {}
        return result;
    };

    __dxCh.onmessage = function (e) {
        try {
            var d = e.data || {};
            if (d.k === 'pin') {
                var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                __dxPin = {
                    t: String(d.t || ''),
                    x: Number(d.x) || 0,
                    y: Number(d.y) || 0,
                    font: d.font || '',
                    cw: Number(d.cw) || 0,
                    ch: Number(d.ch) || 0,
                    size: Number(d.size) || 16,
                    w: Number(d.w) || 0,
                    lastX: Number(d.x) || 0,
                    lastAt: now,
                    speed: 0
                };
                __dxPinCtx = null;
                __dxPinFont = d.font || '';
                __dxPinFill = null;
                __dxPinStroke = null;
                __dxPinHasStroke = false;
            } else if (d.k === 'unpin') {
                __dxPin = null;
                __dxPinCtx = null;
                __dxPinFont = '';
                __dxPinFill = null;
                __dxPinStroke = null;
                __dxPinHasStroke = false;
            } else if (d.k === 'report') {
                __dxReportOn = !!d.on;
                if (!__dxReportOn) {
                    for (var i = 0; i < __dxCtxs.length; i++) __dxCtxs[i].a.length = 0;
                }
            }
        } catch (e) {}
    };
    try { __dxCh.postMessage({ k: 'ready' }); } catch (e) {}
}
}catch(e){}
`;

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        screenActions: true,
        hideGifts: true,
        hoverActions: false,
        autoQuality: true,
        compact: true
    });

    // ---------- 存储 ----------
    function readStoredSettings() {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(STORE_KEY, '');
                if (typeof value === 'string' && value) {
                    let parsed = JSON.parse(value);
                    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
                    return parsed && typeof parsed === 'object' ? parsed : {};
                }
                if (value && typeof value === 'object') return value;
            }
        } catch (e) {
        }
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : {};
            }
        } catch (e) {
        }
        return {};
    }

    function loadSettings() {
        const stored = readStoredSettings();
        return {
            enabled: stored.enabled !== false,
            screenActions: stored.screenActions !== false,
            hideGifts: stored.hideGifts !== false,
            // 公屏列表 +1 已移除，保留字段兼容旧配置但强制关闭
            hoverActions: false,
            autoQuality: stored.autoQuality !== false,
            compact: stored.compact !== false
        };
    }

    const settings = loadSettings();

    function saveSettings() {
        const payload = JSON.stringify({
            enabled: settings.enabled,
            screenActions: settings.screenActions,
            hideGifts: settings.hideGifts,
            hoverActions: false,
            autoQuality: settings.autoQuality,
            compact: settings.compact
        });
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(STORE_KEY, payload);
                return;
            }
        } catch (e) {
        }
        try {
            localStorage.setItem(STORE_KEY, payload);
        } catch (e) {
        }
    }

    // ---------- 工具 ----------
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function log(...args) {
        try {
            console.log('[DouyinEx]', ...args);
        } catch (e) {
        }
    }

    function warn(...args) {
        try {
            console.warn('[DouyinEx]', ...args);
        } catch (e) {
        }
    }

    function isElement(node) {
        return !!(node && node.nodeType === 1);
    }

    function getRoomId() {
        try {
            const match = /^\/(\d+)(?:[/?#]|$)/.exec(location.pathname);
            return match ? match[1] : '';
        } catch (e) {
            return '';
        }
    }

    function isVisible(el) {
        if (!isElement(el)) return false;
        try {
            const rect = el.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        } catch (e) {
            return false;
        }
    }

    function normalizeText(value) {
        return String(value == null ? '' : value)
            .replace(ZERO_WIDTH_RE, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function pageWindow() {
        try {
            return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
        } catch (e) {
            return window;
        }
    }

    // 必须在播放器创建 worker 之前执行（document-start）
    function installDanmakuWorkerHook() {
        const W = pageWindow();
        try {
            if (!W || !W.Blob) return false;
            if (W.Blob.__dyexPatched) return true;
            const OriginalBlob = W.Blob;
            const PatchedBlob = new Proxy(OriginalBlob, {
                construct(target, args, newTarget) {
                    try {
                        const parts = args[0];
                        const type = (args[1] && args[1].type) || '';
                        const isJs = !type || /javascript/i.test(type);
                        if (isJs) {
                            if (typeof parts === 'string' && parts.indexOf('importScripts(') >= 0) {
                                args[0] = parts + SCREEN_WORKER_PATCH;
                            } else if (Array.isArray(parts) &&
                                parts.some((part) => typeof part === 'string' && part.indexOf('importScripts(') >= 0)) {
                                args[0] = parts.concat([SCREEN_WORKER_PATCH]);
                            }
                        }
                    } catch (e) {
                    }
                    return Reflect.construct(target, args, newTarget);
                }
            });
            PatchedBlob.__dyexPatched = true;
            W.Blob = PatchedBlob;
            log('画面弹幕 worker 钩子已安装');
            return true;
        } catch (e) {
            warn('画面弹幕 worker 钩子安装失败', e);
            return false;
        }
    }

    function textFromNode(node) {
        if (!node) return '';
        if (node.nodeType === 3) return node.data || '';
        if (node.nodeType !== 1) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('img').forEach((img) => {
            const label = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
            img.replaceWith(document.createTextNode(label));
        });
        return clone.textContent || '';
    }

    function extractChatData(item) {
        if (!isElement(item)) return null;

        let user = item.querySelector(SEL.username);
        let bodyRoot = null;
        const marker = item.querySelector(
            '.webcast-chatroom___content-with-emoji-text, ' +
            '.webcast-chatroom___content-with-emoji-emoji, ' +
            '.hts-live-text-user'
        );

        if (marker) {
            // 用稳定的正文语义 class 反推正文容器，用户名 class 变了也能用
            const row = marker.closest('.NkS2Invn');
            bodyRoot = marker;
            if (row) {
                while (bodyRoot && bodyRoot.parentElement && bodyRoot.parentElement !== row) {
                    bodyRoot = bodyRoot.parentElement;
                }
                if (!user) {
                    // 再用「以冒号结尾」的文本节点兜底识别用户名，避免把系统消息当弹幕
                    const children = [...row.children];
                    const bodyIndex = children.indexOf(bodyRoot);
                    const end = bodyIndex < 0 ? children.length : bodyIndex;
                    for (let i = 0; i < end; i += 1) {
                        const childText = normalizeText(children[i].textContent || '');
                        if (/[：:]$/.test(childText)) {
                            user = children[i];
                            break;
                        }
                    }
                }
            }
        }

        if (!user) return null;

        let text = '';
        let hasEmoji = false;

        if (bodyRoot) {
            // 只取正文容器，不会把用户名或冒号带进去
            text = textFromNode(bodyRoot);
            hasEmoji = !!(bodyRoot.matches && bodyRoot.matches('img')) || !!bodyRoot.querySelector('img');
        } else {
            let node = user.nextSibling;
            while (node) {
                text += textFromNode(node);
                if (node.nodeType === 1 && (node.matches('img') || node.querySelector('img'))) {
                    hasEmoji = true;
                }
                node = node.nextSibling;
            }
        }

        text = normalizeText(text);
        if (!text) return null;
        return { text, hasEmoji };
    }

    function isChatMessageItem(item) {
        if (!isElement(item)) return false;
        if (!item.closest(SEL.chatList) && !item.closest('#chatroom')) return false;
        return isVisible(item);
    }

    function findChatList(item) {
        const known = item.closest(SEL.chatList);
        if (known) return known;
        let node = item.parentElement;
        while (node && node !== document.body) {
            try {
                const style = getComputedStyle(node);
                if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) {
                    return node;
                }
            } catch (e) {
            }
            node = node.parentElement;
        }
        return null;
    }

    async function waitUntil(check, timeout, interval) {
        const start = Date.now();
        while (Date.now() - start <= timeout) {
            try {
                if (check()) return true;
            } catch (e) {
            }
            await sleep(interval || 50);
        }
        return false;
    }

    function isDisabledElement(el) {
        if (!isElement(el)) return true;
        try {
            if (el.disabled) return true;
            if (el.getAttribute('aria-disabled') === 'true') return true;
            if (el.getAttribute('disabled') !== null) return true;
            const className = typeof el.className === 'string' ? el.className : '';
            if (/\bdisabled\b/i.test(className)) return true;
            if (getComputedStyle(el).pointerEvents === 'none') return true;
        } catch (e) {
        }
        return false;
    }

    function makeReactEvent(el) {
        const event = {
            type: 'click',
            target: el,
            currentTarget: el,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            nativeEvent: {
                type: 'click',
                target: el,
                currentTarget: el,
                isTrusted: true,
                preventDefault() {
                },
                stopPropagation() {
                }
            },
            preventDefault() {
                event.defaultPrevented = true;
            },
            stopPropagation() {
            },
            isDefaultPrevented() {
                return event.defaultPrevented;
            },
            isPropagationStopped() {
                return false;
            },
            persist() {
            }
        };
        return event;
    }

    // 部分按钮的原生 click 会被站点拦截，必要时直接调用 React 的 onClick
    function callReactClick(el) {
        if (!isElement(el)) return false;
        let node = el;
        let depth = 0;
        while (node && depth < 6) {
            try {
                const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps'));
                if (propsKey) {
                    const props = node[propsKey];
                    const handler = props && props.onClick;
                    if (typeof handler === 'function') {
                        handler(makeReactEvent(node));
                        return true;
                    }
                }
                const instanceKey = Object.keys(node).find((key) => key.startsWith('__reactInternalInstance'));
                if (instanceKey) {
                    let fiber = node[instanceKey];
                    let fiberDepth = 0;
                    while (fiber && fiberDepth < 6) {
                        const props = fiber.memoizedProps;
                        const handler = props && props.onClick;
                        if (typeof handler === 'function') {
                            handler(makeReactEvent(node));
                            return true;
                        }
                        fiber = fiber.return;
                        fiberDepth += 1;
                    }
                }
            } catch (e) {
            }
            node = node.parentElement;
            depth += 1;
        }
        return false;
    }

    // ---------- 弹幕列表冻结 ----------
    const ui = {
        booted: false,
        host: null,
        fab: null,
        panel: null,
        actions: null,
        toast: null,
        plusBtn: null,
        copyBtn: null,
        screenActions: null,
        screenPlusBtn: null,
        screenCopyBtn: null,
        screenHighlight: null,
        href: location.href,
        roomId: '',
        inRoom: false
    };

    const chat = {
        active: null,
        frozen: null,
        hideTimer: 0,
        switchTimer: 0,
        pendingItem: null,
        pendingX: 0
    };

    // ---------- 画面弹幕（Canvas）悬停 +1 / 复制 ----------
    const screen = {
        ch: null,
        enabled: false,
        items: [],
        hover: null,
        pinned: false,
        hideTimer: 0,

        bind() {
            if (this.ch) return;
            try {
                const BC = pageWindow().BroadcastChannel || BroadcastChannel;
                this.ch = new BC(SCREEN_CHANNEL);
                this.ch.onmessage = (event) => this.onMessage(event.data);
                this.sendReportState();
            } catch (e) {
                this.ch = null;
                warn('画面弹幕通道不可用', e);
            }
        },

        sendReportState() {
            if (!this.ch) return;
            try {
                this.ch.postMessage({ k: 'report', on: this.enabled });
            } catch (e) {
            }
        },

        setEnabled(on) {
            const next = !!(on && settings.enabled && settings.screenActions && getRoomId());
            if (this.enabled && !next) this.hide();
            this.enabled = next;
            if (!next) this.items = [];
            this.sendReportState();
        },

        onMessage(data) {
            if (!data) return;
            if (data.k === 'ready') {
                this.sendReportState();
                return;
            }
            if (data.k === 'f' && Array.isArray(data.items)) {
                if (this.enabled) this.items = data.items;
            }
        },

        canvas() {
            const list = [...document.querySelectorAll('.CanvasDanmakuPlugin canvas')];
            let fallback = null;
            for (const canvas of list) {
                try {
                    const rect = canvas.getBoundingClientRect();
                    if (rect.width > 20 && rect.height > 20) return canvas;
                    if (!fallback) fallback = canvas;
                } catch (e) {
                }
            }
            return fallback;
        },

        pickGroup() {
            if (!this.items.length) return null;
            const canvas = this.canvas();
            if (canvas) {
                const dpr = window.devicePixelRatio || 1;
                const candidates = [
                    [canvas.width, canvas.height],
                    [Math.round(canvas.width * dpr), Math.round(canvas.height * dpr)]
                ];
                for (const [width, height] of candidates) {
                    const exact = this.items.filter((item) => item[4] === width && item[5] === height);
                    if (exact.length) return exact;
                }
            }
            const groups = new Map();
            for (const item of this.items) {
                const key = item[4] + 'x' + item[5];
                groups.set(key, (groups.get(key) || 0) + 1);
            }
            let bestKey = null;
            let bestCount = 0;
            for (const item of this.items) {
                const key = item[4] + 'x' + item[5];
                const count = groups.get(key);
                if (count > bestCount) {
                    bestCount = count;
                    bestKey = key;
                }
            }
            if (!bestKey) return null;
            return this.items.filter((item) => item[4] + 'x' + item[5] === bestKey);
        },

        pick(px, py) {
            const group = this.pickGroup();
            if (!group) return null;
            let hit = null;
            let bestTop = Infinity;
            for (const item of group) {
                const [text, x, y, font, cw, ch, width] = item;
                if (!text) continue;
                const size = parseFloat(String(font).match(/(\d+(?:\.\d+)?)px/)?.[1] || '20');
                const top = y;
                const bottom = y + size * 1.25;
                if (px >= x - 4 &&
                    px <= x + (width || size * text.length) + 4 &&
                    py >= top - 3 &&
                    py <= bottom) {
                    if (!hit || top < bestTop) {
                        hit = { item, top, bottom, size, w: width || 0, text, x, font, cw, ch };
                        bestTop = top;
                    }
                }
            }
            return hit;
        },

        pickAtClient(clientX, clientY) {
            const canvas = this.canvas();
            if (!canvas) return null;
            let rect;
            try {
                rect = canvas.getBoundingClientRect();
            } catch (e) {
                return null;
            }
            if (rect.width < 1 || rect.height < 1) return null;
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
                return null;
            }
            const group = this.pickGroup();
            if (!group || !group.length) return null;
            const cw = group[0][4] || canvas.width || rect.width;
            const ch = group[0][5] || canvas.height || rect.height;
            const sx = cw / rect.width;
            const sy = ch / rect.height;
            const hit = this.pick((clientX - rect.left) * sx, (clientY - rect.top) * sy);
            return hit ? { hit, rect, sx, sy } : null;
        },

        onMove(event) {
            if (!this.enabled || !getRoomId()) {
                if (this.hover) this.scheduleHide();
                return;
            }

            const target = event.target;
            if (isElement(target)) {
                if (ui.screenActions && ui.screenActions.contains(target)) {
                    this.cancelHide();
                    return;
                }
                if ((ui.panel && ui.panel.contains(target)) ||
                    (ui.fab && ui.fab.contains(target))) {
                    this.scheduleHide();
                    return;
                }
            }

            if (!this.items.length) {
                this.scheduleHide();
                return;
            }

            // 指针还在被钉住的弹幕附近（含菜单前的几像素空隙）时不要切换目标
            if (this.hover && this.pointerInHover(event.clientX, event.clientY)) {
                this.cancelHide();
                return;
            }

            const found = this.pickAtClient(event.clientX, event.clientY);
            if (!found) {
                this.scheduleHide();
                return;
            }

            this.cancelHide();
            if (this.hover && this.sameHover(found)) {
                this.hover.rect = found.rect;
                this.hover.sx = found.sx;
                this.hover.sy = found.sy;
                this.placeUi();
                return;
            }

            this.activate(found);
        },

        pointerInHover(clientX, clientY) {
            if (!this.hover) return false;
            const canvas = this.canvas();
            if (!canvas) return false;
            let rect;
            try {
                rect = canvas.getBoundingClientRect();
            } catch (e) {
                return false;
            }
            const { hit, sx, sy } = this.hover;
            if (!rect.width || !rect.height || !sx || !sy) return false;
            const left = rect.left + hit.x / sx;
            const top = rect.top + hit.top / sy;
            const size = hit.size / sy;
            const width = (hit.w || hit.size * hit.text.length) / sx;
            return clientX >= left - 12 &&
                clientX <= left + width + 12 &&
                clientY >= top - 8 &&
                clientY <= top + size + 8;
        },

        sameHover(found) {
            if (!this.hover) return false;
            const a = this.hover.hit;
            const b = found.hit;
            return a.text === b.text && Math.abs(a.x - b.x) < 6 && Math.abs(a.top - b.top) < 6;
        },

        activate(found) {
            this.cancelHide();
            closeChatActions();
            this.hover = {
                hit: found.hit,
                rect: found.rect,
                sx: found.sx,
                sy: found.sy
            };
            this.pin(found.hit);
            this.showUi();
        },

        pin(hit) {
            if (!this.ch) return;
            try {
                this.ch.postMessage({
                    k: 'pin',
                    t: hit.text,
                    x: hit.x,
                    y: hit.top,
                    font: hit.font,
                    cw: hit.cw,
                    ch: hit.ch,
                    size: hit.size,
                    w: hit.w
                });
                this.pinned = true;
            } catch (e) {
            }
        },

        unpin() {
            if (this.ch && this.pinned) {
                try {
                    this.ch.postMessage({ k: 'unpin' });
                } catch (e) {
                }
            }
            this.pinned = false;
        },

        showUi() {
            if (!this.enabled || !this.hover) return;
            if (ui.screenActions) {
                ui.screenActions.style.visibility = 'hidden';
                ui.screenActions.dataset.open = '1';
            }
            if (ui.screenHighlight) ui.screenHighlight.style.display = 'block';
            this.placeUi();
        },

        placeUi() {
            if (!this.hover || !ui.screenActions) return;
            const { hit, rect, sx, sy } = this.hover;
            if (!rect.width || !rect.height) {
                this.hide();
                return;
            }

            const menu = ui.screenActions;
            const menuWidth = menu.offsetWidth || 97;
            const menuHeight = menu.offsetHeight || 35;
            const left = rect.left + hit.x / sx;
            const top = rect.top + hit.top / sy;
            const size = hit.size / sy;
            const textWidth = (hit.w || hit.size * hit.text.length) / sx;

            let x = left + textWidth + 2;
            if (x + menuWidth > window.innerWidth - 8) x = left - menuWidth - 2;
            if (x < 8) x = Math.min(left + 2, window.innerWidth - menuWidth - 8);
            let y = top + size / 2 - menuHeight / 2;
            y = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));

            menu.style.left = Math.round(x) + 'px';
            menu.style.top = Math.round(y) + 'px';
            menu.style.visibility = 'visible';

            if (ui.screenHighlight) {
                const padX = 4;
                const padY = 3;
                ui.screenHighlight.style.left = Math.round(left - padX) + 'px';
                ui.screenHighlight.style.top = Math.round(top - padY) + 'px';
                ui.screenHighlight.style.width = Math.round(Math.max(12, textWidth + padX * 2)) + 'px';
                ui.screenHighlight.style.height = Math.round(Math.max(12, size + padY * 2)) + 'px';
                ui.screenHighlight.style.display = 'block';
            }
        },

        reposition() {
            if (!this.hover) return;
            const canvas = this.canvas();
            if (!canvas) {
                this.hide();
                return;
            }
            let rect;
            try {
                rect = canvas.getBoundingClientRect();
            } catch (e) {
                this.hide();
                return;
            }
            if (!rect.width || !rect.height) {
                this.hide();
                return;
            }
            const group = this.pickGroup();
            if (group && group.length) {
                this.hover.sx = (group[0][4] || canvas.width || rect.width) / rect.width;
                this.hover.sy = (group[0][5] || canvas.height || rect.height) / rect.height;
            }
            this.hover.rect = rect;
            this.placeUi();
        },

        scheduleHide() {
            if (!this.hover || this.hideTimer) return;
            this.hideTimer = setTimeout(() => {
                this.hideTimer = 0;
                this.hide();
            }, 380);
        },

        cancelHide() {
            if (!this.hideTimer) return;
            clearTimeout(this.hideTimer);
            this.hideTimer = 0;
        },

        hide() {
            this.cancelHide();
            this.hover = null;
            if (ui.screenActions) {
                ui.screenActions.dataset.open = '0';
                ui.screenActions.style.visibility = 'hidden';
            }
            if (ui.screenHighlight) ui.screenHighlight.style.display = 'none';
            this.unpin();
        },

        currentText() {
            return this.hover && this.hover.hit ? this.hover.hit.text : '';
        }
    };

    const giftFilter = {
        scan() {
            const on = !!(settings.enabled && settings.hideGifts && getRoomId());
            try {
                document.documentElement.classList.toggle('dyex-hide-gifts', on);
            } catch (e) {
            }

            if (!on) {
                document.querySelectorAll('.dyex-gift-hidden').forEach((el) => el.classList.remove('dyex-gift-hidden'));
                return;
            }

            const giftPattern = /送出了|粉丝团灯牌|点亮粉丝团|送为你闪耀|为你闪耀/;
            const chatItems = document.querySelectorAll('.webcast-chatroom___item-wrapper, .webcast-chatroom___item');
            for (const el of chatItems) {
                const text = normalizeText(el.innerText || '');
                if (!text) continue;
                const isGift = giftPattern.test(text);
                const isJoin = /加入了直播间|进入了直播间|关注了主播|分享了直播间/.test(text);
                const isNotice = /(?:来了|为主播点赞了)$/.test(text) && !/[：:]/.test(text);
                const isSystem = /欢迎来到直播间|抖音严禁未成年人直播|理性消费|谨防网络诈骗/.test(text) && !/[：:]/.test(text);
                const container = el.closest('[data-index]') || el.closest('.webcast-chatroom___item') || el;
                container.classList.toggle('dyex-gift-hidden', isGift || isJoin || isNotice || isSystem);
            }

            const bottomNotices = document.querySelectorAll(
                '[class*="webcast-chatroom___bottom-message"], [class*="webcast-chatroom___bottom_message"]'
            );
            for (const el of bottomNotices) {
                const text = normalizeText(el.innerText || '');
                el.classList.toggle('dyex-gift-hidden', /(?:来了|为主播点赞了)$/.test(text));
            }

            // 礼物飘屏兜底：按文字 + 礼物相关 class 找卡片，不碰底部礼物栏和公屏
            const candidates = document.querySelectorAll('[class*="gift" i], [class*="Gift"]');
            if (!candidates.length) return;
            for (const el of candidates) {
                if (el.closest('#BottomLayout') ||
                    el.closest('[data-e2e="gifts-container"]') ||
                    el.closest('.webcast-chatroom') ||
                    el.closest('#dyex-host') ||
                    el.closest('[class*="gift-panel" i], [data-e2e*="gift-panel" i]')) {
                    continue;
                }
                if (!isVisible(el)) continue;
                const text = normalizeText(el.innerText || '');
                if (!text || text.length > 160) continue;
                if (!/(?:送出了|送为你闪耀|为你闪耀)/.test(text)) continue;
                let rect;
                try {
                    rect = el.getBoundingClientRect();
                } catch (e) {
                    continue;
                }
                if (rect.width > 520 || rect.height > 320) continue;
                el.classList.add('dyex-gift-hidden');
            }
        }
    };

    function freezeChatList(list) {
        if (!list) return;
        if (chat.frozen && chat.frozen.list === list) return;
        unfreezeChatList();

        let scrollTopDescriptor = null;
        try {
            scrollTopDescriptor =
                Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') ||
                Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
        } catch (e) {
        }
        if (!scrollTopDescriptor || !scrollTopDescriptor.get || !scrollTopDescriptor.set) return;

        let baseTop = 0;
        try {
            baseTop = scrollTopDescriptor.get.call(list);
        } catch (e) {
            return;
        }

        const frozen = {
            list,
            scrollTopDescriptor,
            baseTop,
            pendingTop: baseTop,
            ownScrollTop: Object.getOwnPropertyDescriptor(list, 'scrollTop'),
            ownScrollTo: Object.getOwnPropertyDescriptor(list, 'scrollTo'),
            ownScrollBy: Object.getOwnPropertyDescriptor(list, 'scrollBy'),
            wheelHandler: null
        };

        try {
            Object.defineProperty(list, 'scrollTop', {
                configurable: true,
                enumerable: true,
                get() {
                    return frozen.baseTop;
                },
                set(value) {
                    const next = Number(value);
                    if (Number.isFinite(next)) frozen.pendingTop = next;
                }
            });
        } catch (e) {
            return;
        }

        try {
            list.scrollTo = function () {
                const first = arguments[0];
                const top = first && typeof first === 'object' ? first.top : arguments[1];
                const next = Number(top);
                if (Number.isFinite(next)) frozen.pendingTop = next;
            };
        } catch (e) {
        }
        try {
            list.scrollBy = function () {
                const first = arguments[0];
                const top = first && typeof first === 'object' ? first.top : arguments[1];
                const next = Number(top);
                if (Number.isFinite(next)) frozen.pendingTop = Math.max(0, frozen.pendingTop + next);
            };
        } catch (e) {
        }

        const wheelHandler = (event) => {
            try {
                event.preventDefault();
                event.stopPropagation();
            } catch (e) {
            }
        };
        try {
            list.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
            frozen.wheelHandler = wheelHandler;
        } catch (e) {
        }

        chat.frozen = frozen;
    }

    function unfreezeChatList() {
        const frozen = chat.frozen;
        if (!frozen) return;
        chat.frozen = null;
        const list = frozen.list;

        if (frozen.wheelHandler) {
            try {
                list.removeEventListener('wheel', frozen.wheelHandler, true);
            } catch (e) {
            }
        }

        try {
            if (frozen.ownScrollTop) {
                Object.defineProperty(list, 'scrollTop', frozen.ownScrollTop);
            } else {
                delete list.scrollTop;
            }
        } catch (e) {
        }
        try {
            if (frozen.ownScrollTo) {
                Object.defineProperty(list, 'scrollTo', frozen.ownScrollTo);
            } else {
                delete list.scrollTo;
            }
        } catch (e) {
        }
        try {
            if (frozen.ownScrollBy) {
                Object.defineProperty(list, 'scrollBy', frozen.ownScrollBy);
            } else {
                delete list.scrollBy;
            }
        } catch (e) {
        }

        try {
            const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
            const targetTop = Math.max(0, Math.min(frozen.pendingTop, maxTop));
            const currentTop = frozen.scrollTopDescriptor.get.call(list);
            if (Math.abs(currentTop - targetTop) > 1) {
                frozen.scrollTopDescriptor.set.call(list, targetTop);
            }
        } catch (e) {
        }
    }

    // ---------- 输入框 / 发送 ----------
    function findVisible(selector, root) {
        try {
            const scope = root || document;
            for (const el of scope.querySelectorAll(selector)) {
                if (isVisible(el)) return el;
            }
        } catch (e) {
        }
        return null;
    }

    function isUsableInput(el) {
        if (!isElement(el)) return false;
        const tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !el.isContentEditable) return false;
        if (tag === 'INPUT' && el.type === 'search') return false;
        if (el.closest('[data-e2e="searchbar"], [data-e2e="searchbar-input"]')) return false;
        if (tag === 'INPUT') {
            const placeholder = (el.getAttribute('placeholder') || '').trim();
            if (/搜索|表情|search/i.test(placeholder)) return false;
            if (el.closest('[class*="emoji"], [class*="Emoji"]')) return false;
        }
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.readOnly) return false;
        if (el.isContentEditable && el.getAttribute('contenteditable') === 'false') return false;
        return true;
    }

    function findChatInput() {
        for (const selector of SEL.inputCandidates) {
            const el = findVisible(selector);
            if (el && isUsableInput(el)) return el;
        }
        const chatRoot = document.querySelector('#chatroom, .webcast-chatroom');
        if (chatRoot) {
            for (const el of chatRoot.querySelectorAll('textarea, input, [contenteditable="true"]')) {
                if (isVisible(el) && isUsableInput(el)) return el;
            }
        }
        return null;
    }

    function inputHasContent(input) {
        if (!isElement(input)) return false;
        try {
            if (input.isContentEditable) {
                if (normalizeText(input.textContent || '')) return true;
                return !!(input.querySelector('img, [data-emoji], .webcast-chatroom___content-with-emoji-emoji'));
            }
            return !!normalizeText(input.value || '');
        } catch (e) {
            return false;
        }
    }

    function inputMatches(input, text) {
        if (!isElement(input)) return false;
        try {
            if (input.isContentEditable) {
                let current = normalizeText(input.textContent || '');
                if (current === text) return true;
                // 编辑器可能把 [比心] 之类的文本转成表情图片，用 alt 还原后再比一次
                try {
                    const clone = input.cloneNode(true);
                    clone.querySelectorAll('img').forEach((img) => {
                        const label = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
                        img.replaceWith(document.createTextNode(label));
                    });
                    current = normalizeText(clone.textContent || '');
                } catch (e) {
                }
                return current === text;
            }
            return normalizeText(input.value || '') === text;
        } catch (e) {
            return false;
        }
    }

    function currentInputHasContent(input) {
        if (input && input.isConnected) return inputHasContent(input);
        return inputHasContent(findChatInput());
    }

    async function setInputText(input, text) {
        try {
            input.focus();
        } catch (e) {
        }

        if (input.isContentEditable) {
            let inserted = false;
            try {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                selection.removeAllRanges();
                selection.addRange(range);
                inserted = document.execCommand('insertText', false, text);
            } catch (e) {
            }
            if (!inserted) {
                try {
                    input.textContent = text;
                    input.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        cancelable: true,
                        inputType: 'insertText',
                        data: text
                    }));
                } catch (e) {
                    try {
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    } catch (_) {
                    }
                }
            }
            try {
                input.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {
            }
            return true;
        }

        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        try {
            if (descriptor && descriptor.set) descriptor.set.call(input, text);
            else input.value = text;
        } catch (e) {
            try {
                input.value = text;
            } catch (_) {
            }
        }
        try {
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: text
            }));
        } catch (e) {
            try {
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (_) {
            }
        }
        try {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
        }
        return true;
    }

    async function clearInput(input) {
        if (!isElement(input)) return;
        try {
            input.focus();
        } catch (e) {
        }
        if (input.isContentEditable) {
            try {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                selection.removeAllRanges();
                selection.addRange(range);
                document.execCommand('delete', false);
            } catch (e) {
            }
            if (inputHasContent(input)) {
                try {
                    input.textContent = '';
                } catch (e) {
                }
                try {
                    input.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'deleteContentBackward'
                    }));
                } catch (e) {
                    try {
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    } catch (_) {
                    }
                }
            }
            return;
        }
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        try {
            if (descriptor && descriptor.set) descriptor.set.call(input, '');
            else input.value = '';
        } catch (e) {
            try {
                input.value = '';
            } catch (_) {
            }
        }
        try {
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'deleteContentBackward'
            }));
        } catch (e) {
            try {
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (_) {
            }
        }
        try {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
        }
    }

    function findSendButton(input) {
        const container = input.closest(SEL.inputContainer);
        const roots = [];
        if (container) roots.push(container);
        if (input.parentElement) roots.push(input.parentElement);
        roots.push(document);

        for (const root of roots) {
            for (const selector of SEL.sendBtnCandidates) {
                try {
                    for (const el of root.querySelectorAll(selector)) {
                        if (isVisible(el) && !isDisabledElement(el)) return el;
                    }
                } catch (e) {
                }
            }
        }

        if (container) {
            const candidates = [];
            for (const el of container.querySelectorAll('button, [role="button"], div, span')) {
                if (!isVisible(el) || isDisabledElement(el)) continue;
                const text = (el.textContent || '').trim();
                const aria = (el.getAttribute('aria-label') || '').trim();
                if ((/^发送$/.test(text) || aria === '发送') && el.children.length <= 1) {
                    candidates.push(el);
                }
            }
            if (candidates.length) return candidates[candidates.length - 1];
        }
        return null;
    }

    function pressEnter(input) {
        try {
            input.focus();
        } catch (e) {
        }
        const base = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        };
        for (const type of ['keydown', 'keypress', 'keyup']) {
            try {
                const options = type === 'keypress' ? Object.assign({}, base, { charCode: 13 }) : base;
                input.dispatchEvent(new KeyboardEvent(type, options));
            } catch (e) {
            }
        }
    }

    const sender = {
        busy: false,
        lastAt: 0
    };

    async function sendDanmaku(rawText) {
        const text = normalizeText(rawText);
        if (!text) return { ok: false, reason: '弹幕内容为空' };
        if (sender.busy) return { ok: false, reason: '正在发送，请稍候' };
        if (Date.now() - sender.lastAt < 2000) {
            return { ok: false, reason: '操作太频繁，请稍后再试' };
        }

        const input = findChatInput();
        if (!input) return { ok: false, reason: '未登录或未找到聊天输入框' };
        if (!isUsableInput(input)) return { ok: false, reason: '当前输入框不可用' };
        if (inputHasContent(input)) return { ok: false, reason: '发送框有内容，已取消 +1' };

        sender.busy = true;
        try {
            await setInputText(input, text);
            const written = await waitUntil(
                () => inputMatches(input, text) ||
                    (input.isContentEditable && inputHasContent(input) && !normalizeText(input.textContent || '')),
                1400,
                50
            );
            if (!written) {
                await clearInput(input);
                return { ok: false, reason: '内容未能写入输入框' };
            }

            sender.lastAt = Date.now();

            let sendButton = null;
            for (let i = 0; i < 6; i += 1) {
                sendButton = findSendButton(input);
                if (sendButton) break;
                await sleep(100);
            }

            if (sendButton) {
                let usedReact = false;
                try {
                    usedReact = callReactClick(sendButton);
                } catch (e) {
                }
                if (!usedReact) {
                    try {
                        sendButton.click();
                    } catch (e) {
                    }
                }

                if (await waitUntil(() => !currentInputHasContent(input), 1600, 50)) {
                    return await finishSend(input);
                }

                // 第一种点击方式没生效时再试另一种，避免无限点击
                try {
                    if (usedReact) sendButton.click();
                    else callReactClick(sendButton);
                } catch (e) {
                }
                if (await waitUntil(() => !currentInputHasContent(input), 1600, 50)) {
                    return await finishSend(input);
                }
            } else {
                pressEnter(input);
                if (await waitUntil(() => !currentInputHasContent(input), 1800, 50)) {
                    return await finishSend(input);
                }
            }

            return { ok: false, reason: '发送超时，可能被限制或内容不合规' };
        } catch (e) {
            warn('发送异常', e);
            return { ok: false, reason: '发送异常，请查看控制台' };
        } finally {
            sender.busy = false;
        }
    }

    async function finishSend(input) {
        try {
            await sleep(60);
            const current = input && input.isConnected ? input : findChatInput();
            if (current && typeof current.blur === 'function') current.blur();
        } catch (e) {
        }
        return { ok: true };
    }

    // ---------- 自动最高画质 ----------
    function getCurrentQuality() {
        const label = document.querySelector(SEL.qualityLabel);
        return normalizeText(label ? label.textContent : '');
    }

    function rankOfQuality(name) {
        const index = QUALITY_RANKS.findIndex((quality) => name.includes(quality));
        return index < 0 ? 999 : index;
    }

    function readQualityTiers() {
        const list = document.querySelector(SEL.qualityList);
        if (!list) return [];
        const current = getCurrentQuality();
        const tiers = [];
        for (const el of list.children) {
            if (!isElement(el)) continue;
            const raw = normalizeText(el.textContent || '');
            if (!raw) continue;
            const locked = LOCK_TEXT_RE.test(raw);
            const name = normalizeText(raw.replace(LOCK_STRIP_RE, '')) || raw;
            if (!name) continue;
            const inner = el.firstElementChild || el;
            const style = inner.getAttribute('style') || '';
            const selected = /background/i.test(style) || (!!current && (current === name || current.includes(name)));
            tiers.push({ el, clickEl: inner, name, locked, selected });
        }
        return tiers;
    }

    function pickQualityTier(tiers) {
        const usable = tiers.filter((tier) => !tier.locked);
        if (!usable.length) return null;
        let best = null;
        for (const tier of usable) {
            if (!best || rankOfQuality(tier.name) < rankOfQuality(best.name)) best = tier;
        }
        return best;
    }

    const quality = {
        roomId: '',
        session: 0,
        timer: 0,
        running: false,
        done: false,
        userOverride: false,
        attempts: 0,
        clickMode: 'native',

        clearTimer() {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = 0;
            }
        },

        resetSession() {
            this.session += 1;
            this.clearTimer();
            this.running = false;
            this.done = false;
            this.userOverride = false;
            this.attempts = 0;
            this.clickMode = 'native';
        },

        start(roomId, reset) {
            if (!roomId || !settings.enabled || !settings.autoQuality) {
                this.stop();
                return;
            }
            if (this.roomId !== roomId) {
                this.roomId = roomId;
                reset = true;
            }
            if (reset) this.resetSession();
            if (this.done || this.userOverride) return;
            if (this.timer || this.running) return;
            this.schedule(900);
        },

        stop() {
            this.session += 1;
            this.clearTimer();
            this.running = false;
            this.roomId = '';
            this.done = true;
            this.userOverride = false;
            this.attempts = 0;
        },

        schedule(delay) {
            this.clearTimer();
            const session = this.session;
            this.timer = setTimeout(() => {
                this.timer = 0;
                if (session !== this.session) return;
                this.attempt();
            }, delay);
        },

        canRun(session) {
            return session === this.session &&
                !!getRoomId() &&
                settings.enabled &&
                settings.autoQuality &&
                !this.userOverride &&
                !this.done;
        },

        clickTier(tier) {
            try {
                if (this.clickMode === 'react') {
                    if (!callReactClick(tier.clickEl) && !callReactClick(tier.el)) {
                        tier.clickEl.click();
                    }
                } else {
                    try {
                        tier.clickEl.click();
                    } catch (e) {
                        tier.el.click();
                    }
                }
            } catch (e) {
                warn('切换画质点击失败', e);
            }
        },

        async attempt() {
            if (this.running) return;
            this.running = true;
            const session = this.session;
            try {
                if (!this.canRun(session)) return;
                this.attempts += 1;

                const tiers = readQualityTiers();
                if (!tiers.length) {
                    if (this.attempts < 10 && this.canRun(session)) this.schedule(1500);
                    else this.done = true;
                    return;
                }

                const target = pickQualityTier(tiers);
                if (!target) {
                    this.done = true;
                    return;
                }

                const current = getCurrentQuality();
                if (target.selected || (current && (current === target.name || current.includes(target.name)))) {
                    this.done = true;
                    return;
                }

                this.clickTier(target);
                await sleep(900);
                if (!this.canRun(session)) return;

                if (getCurrentQuality().includes(target.name)) {
                    this.done = true;
                    log('画质已切换:', target.name);
                    return;
                }

                if (this.attempts < 10) {
                    this.clickMode = this.clickMode === 'native' ? 'react' : 'native';
                    this.schedule(1400);
                } else {
                    this.done = true;
                    warn('自动画质未生效，目标:', target.name, '当前:', getCurrentQuality());
                }
            } catch (e) {
                warn('自动画质异常', e);
                if (this.attempts < 10 && this.canRun(session)) this.schedule(1500);
                else this.done = true;
            } finally {
                this.running = false;
            }
        },

        markUserOverride() {
            if (!settings.enabled || !settings.autoQuality || !getRoomId()) return;
            this.userOverride = true;
            this.clearTimer();
            log('检测到手动调整画质，本房间停止自动切换');
        }
    };

    // ---------- 样式 ----------
    function injectStyles() {
        if (document.getElementById('dyex-style')) return;
        const style = document.createElement('style');
        style.id = 'dyex-style';
        style.textContent = `
html.dyex-compact #BottomLayout { display: none !important; }

html.dyex-hide-gifts [class*="GiftTrayPlugin"],
html.dyex-hide-gifts [class*="GiftTray"],
html.dyex-hide-gifts [class*="gift-tray"],
html.dyex-hide-gifts [class*="gift_tray"] { display: none !important; }
html.dyex-hide-gifts .douyin-player [class*="GiftMessage"],
html.dyex-hide-gifts .douyin-player [class*="gift-message"],
html.dyex-hide-gifts #LeftBackgroundLayout [class*="GiftMessage"],
html.dyex-hide-gifts #LeftBackgroundLayout [class*="gift-message"] { display: none !important; }
.dyex-gift-hidden { display: none !important; }

#dyex-host {
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483646 !important;
    pointer-events: none !important;
    font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", "Segoe UI", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    color: #fff;
    direction: ltr;
}
#dyex-host, #dyex-host * { box-sizing: border-box; }

#dyex-fab {
    position: fixed !important;
    left: 12px;
    bottom: 64px;
    z-index: 2147483603 !important;
    width: 34px;
    height: 34px;
    margin: 0;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, .18);
    border-radius: 50%;
    background: rgba(18, 18, 22, .62);
    color: rgba(255, 255, 255, .9);
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: .42;
    pointer-events: auto !important;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow: 0 2px 12px rgba(0, 0, 0, .35);
    transition: opacity .15s ease, background .15s ease, border-color .15s ease;
    -webkit-appearance: none;
    appearance: none;
}
#dyex-fab:hover {
    opacity: 1;
    background: rgba(254, 44, 85, .92);
    border-color: rgba(255, 255, 255, .3);
}
#dyex-fab[data-off="1"] { opacity: .2; }
#dyex-fab svg { width: 17px; height: 17px; display: block; fill: currentColor; pointer-events: none; }

#dyex-panel {
    position: fixed !important;
    z-index: 2147483604 !important;
    display: none;
    width: 252px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    padding: 13px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 12px;
    background: rgba(22, 22, 27, .96);
    color: #fff;
    box-shadow: 0 14px 48px rgba(0, 0, 0, .55);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    pointer-events: auto !important;
    user-select: none;
    -webkit-user-select: none;
}
#dyex-panel[data-open="1"] { display: block; }
#dyex-panel .dyex-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
}
#dyex-panel .dyex-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
}
#dyex-panel .dyex-ver {
    margin-left: 4px;
    font-size: 10px;
    font-weight: 500;
    color: rgba(255, 255, 255, .5);
}
#dyex-panel .dyex-close {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, .66);
    font-size: 18px;
    line-height: 22px;
    cursor: pointer;
}
#dyex-panel .dyex-close:hover { background: rgba(255, 255, 255, .1); color: #fff; }
#dyex-panel .dyex-row {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    padding: 7px 6px;
    border-radius: 7px;
    color: rgba(255, 255, 255, .92);
    font-size: 12px;
    font-weight: 400;
    cursor: pointer;
}
#dyex-panel .dyex-row:hover { background: rgba(255, 255, 255, .06); }
#dyex-panel .dyex-master {
    margin-bottom: 4px;
    padding: 8px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, .1);
    border-radius: 7px 7px 0 0;
    font-weight: 600;
}
#dyex-panel .dyex-row[data-disabled="1"] { opacity: .38; cursor: not-allowed; }
#dyex-panel .dyex-row[data-disabled="1"]:hover { background: transparent; }
#dyex-panel input[type="checkbox"] {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    margin: 0;
    padding: 0;
    accent-color: #fe2c55;
    cursor: pointer;
    -webkit-appearance: checkbox;
    appearance: auto;
}
#dyex-panel input[type="checkbox"]:disabled { cursor: not-allowed; }
#dyex-panel .dyex-foot {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, .08);
    color: rgba(255, 255, 255, .42);
    font-size: 10px;
    line-height: 1.4;
}

#dyex-actions,
#dyex-screen-actions {
    position: fixed !important;
    z-index: 2147483605 !important;
    display: none;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 9px;
    background: rgba(22, 22, 27, .95);
    box-shadow: 0 6px 22px rgba(0, 0, 0, .5);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    pointer-events: auto !important;
    user-select: none;
    -webkit-user-select: none;
    visibility: hidden;
}
#dyex-actions[data-open="1"],
#dyex-screen-actions[data-open="1"] { display: flex; }
#dyex-actions button,
#dyex-screen-actions button {
    height: 25px;
    margin: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    color: #fff;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 25px;
    white-space: nowrap;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
}
#dyex-plus1,
#dyex-screen-plus1 { background: #fe2c55; }
#dyex-plus1:hover,
#dyex-screen-plus1:hover { background: #ff4168; }
#dyex-copy,
#dyex-screen-copy { background: rgba(255, 255, 255, .16); font-weight: 500; }
#dyex-copy:hover,
#dyex-screen-copy:hover { background: rgba(255, 255, 255, .24); }

#dyex-screen-highlight {
    position: fixed !important;
    z-index: 2147483604 !important;
    display: none;
    pointer-events: none !important;
    border: 1px solid rgba(254, 44, 85, .62);
    border-radius: 6px;
    background: rgba(254, 44, 85, .08);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 0 14px rgba(254, 44, 85, .28);
}

#dyex-toast {
    position: fixed !important;
    left: 50%;
    bottom: 96px;
    z-index: 2147483606 !important;
    display: block;
    max-width: min(80vw, 520px);
    padding: 8px 14px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    background: rgba(20, 20, 24, .92);
    color: #fff;
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 8px 26px rgba(0, 0, 0, .45);
    opacity: 0;
    visibility: hidden;
    transform: translate(-50%, 8px);
    transition: opacity .18s ease, transform .18s ease, visibility .18s ease;
    pointer-events: none !important;
}
#dyex-toast[data-show="1"] {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, 0);
}

html body .webcast-chatroom___item-wrapper.dyex-chat-active {
    background: rgba(255, 255, 255, .09) !important;
    border-radius: 6px !important;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14) !important;
    transition: background .1s ease;
}
`;
        const parent = document.head || document.documentElement;
        if (!parent) return;
        parent.appendChild(style);
    }

    function applyCompactClass() {
        try {
            const enabled = !!(settings.enabled && settings.compact && getRoomId());
            document.documentElement.classList.toggle('dyex-compact', enabled);
        } catch (e) {
        }
    }

    // ---------- UI ----------
    function panelHtml() {
        return `
<div class="dyex-head">
    <div class="dyex-title">DouyinEx <span class="dyex-ver">v${VERSION}</span></div>
    <button type="button" class="dyex-close" id="dyex-panel-close" aria-label="关闭设置">&times;</button>
</div>
<label class="dyex-row dyex-master">
    <input type="checkbox" data-key="enabled">
    <span>启用 DouyinEx</span>
</label>
<label class="dyex-row">
    <input type="checkbox" data-key="screenActions">
    <span>画面弹幕悬停 +1 / 复制</span>
</label>
<label class="dyex-row">
    <input type="checkbox" data-key="hideGifts">
    <span>屏蔽礼物 / 进场消息</span>
</label>
<label class="dyex-row">
    <input type="checkbox" data-key="autoQuality">
    <span>自动最高画质</span>
</label>
<label class="dyex-row">
    <input type="checkbox" data-key="compact">
    <span>精简界面（隐藏礼物栏）</span>
</label>
<div class="dyex-foot">设置即时生效，仅保存在本机</div>`;
    }

    const GEAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.07.63-.07.94s.02.63.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>`;

    function ensureHost() {
        if (ui.host) return ui.host;
        if (!document.body) return null;

        const host = document.createElement('div');
        host.id = 'dyex-host';
        host.innerHTML = `
<button type="button" id="dyex-fab" title="DouyinEx 设置" aria-label="DouyinEx 设置">${GEAR_SVG}</button>
<div id="dyex-panel" role="dialog" aria-label="DouyinEx 设置">${panelHtml()}</div>
<div id="dyex-actions" role="menu" aria-label="公屏弹幕操作">
    <button type="button" id="dyex-plus1" title="发送同样内容">+1</button>
    <button type="button" id="dyex-copy" title="复制弹幕内容">复制</button>
</div>
<div id="dyex-screen-actions" role="menu" aria-label="画面弹幕操作">
    <button type="button" id="dyex-screen-plus1" title="发送同样内容">+1</button>
    <button type="button" id="dyex-screen-copy" title="复制弹幕内容">复制</button>
</div>
<div id="dyex-screen-highlight"></div>
<div id="dyex-toast" role="status" aria-live="polite"></div>`;

        ui.host = host;
        ui.fab = host.querySelector('#dyex-fab');
        ui.panel = host.querySelector('#dyex-panel');
        ui.actions = host.querySelector('#dyex-actions');
        ui.screenActions = host.querySelector('#dyex-screen-actions');
        ui.screenHighlight = host.querySelector('#dyex-screen-highlight');
        ui.toast = host.querySelector('#dyex-toast');
        ui.plusBtn = host.querySelector('#dyex-plus1');
        ui.copyBtn = host.querySelector('#dyex-copy');
        ui.screenPlusBtn = host.querySelector('#dyex-screen-plus1');
        ui.screenCopyBtn = host.querySelector('#dyex-screen-copy');

        bindUi();
        mountHost();
        refreshPanel();
        setFabVisible();
        return host;
    }

    function bindUi() {
        ui.fab.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        ui.fab.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (ui.panel.dataset.open === '1') closePanel();
            else openPanel();
        });

        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel']) {
            ui.panel.addEventListener(type, (event) => event.stopPropagation());
            ui.actions.addEventListener(type, (event) => event.stopPropagation());
            ui.screenActions.addEventListener(type, (event) => event.stopPropagation());
        }

        ui.panel.addEventListener('change', onPanelChange);
        ui.panel.querySelector('#dyex-panel-close').addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closePanel();
        });

        ui.actions.addEventListener('mouseenter', cancelHideChatActions);
        ui.actions.addEventListener('mouseleave', scheduleHideChatActions);
        ui.screenActions.addEventListener('mouseenter', () => screen.cancelHide());
        ui.screenActions.addEventListener('mouseleave', () => screen.scheduleHide());

        ui.plusBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = chat.active ? chat.active.text : '';
            if (!text) return;
            closeChatActions();
            const result = await sendDanmaku(text);
            if (result.ok) {
                showToast('已发送 +1');
            } else {
                showToast('发送失败：' + result.reason, 2600);
            }
        });

        ui.copyBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = chat.active ? chat.active.text : '';
            if (!text) return;
            const ok = await copyText(text);
            showToast(ok ? '已复制' : '复制失败，请手动选择', ok ? 1600 : 2400);
        });

        ui.screenPlusBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = screen.currentText();
            if (!text) return;
            screen.hide();
            const result = await sendDanmaku(text);
            if (result.ok) {
                showToast('已发送 +1');
            } else {
                showToast('发送失败：' + result.reason, 2600);
            }
        });

        ui.screenCopyBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = screen.currentText();
            if (!text) return;
            const ok = await copyText(text);
            showToast(ok ? '已复制' : '复制失败，请手动选择', ok ? 1600 : 2400);
        });
    }

    function mountHost() {
        if (!ui.host) return;
        let parent = document.body || document.documentElement;
        try {
            const fullscreen = document.fullscreenElement;
            if (fullscreen &&
                fullscreen !== ui.host &&
                !ui.host.contains(fullscreen) &&
                fullscreen !== document.documentElement &&
                fullscreen.tagName !== 'VIDEO' &&
                typeof fullscreen.appendChild === 'function') {
                parent = fullscreen;
            }
        } catch (e) {
        }
        if (ui.host.parentElement !== parent) parent.appendChild(ui.host);
    }

    function ensureHostMounted() {
        if (!ui.host) {
            ensureHost();
            return;
        }
        if (!ui.host.isConnected) {
            mountHost();
            return;
        }
        try {
            const fullscreen = document.fullscreenElement;
            if (fullscreen &&
                fullscreen !== ui.host &&
                !ui.host.contains(fullscreen) &&
                fullscreen !== document.documentElement &&
                fullscreen.tagName !== 'VIDEO' &&
                !fullscreen.contains(ui.host)) {
                mountHost();
            }
        } catch (e) {
        }
    }

    function setFabVisible() {
        if (!ui.fab) return;
        ui.fab.style.display = getRoomId() ? 'flex' : 'none';
    }

    function refreshPanel() {
        if (!ui.panel) return;
        for (const input of ui.panel.querySelectorAll('input[data-key]')) {
            const key = input.dataset.key;
            if (!(key in DEFAULT_SETTINGS)) continue;
            input.checked = !!settings[key];
            const disabled = key !== 'enabled' && !settings.enabled;
            input.disabled = disabled;
            const row = input.closest('.dyex-row');
            if (row) row.dataset.disabled = disabled ? '1' : '0';
        }
        if (ui.fab) ui.fab.dataset.off = settings.enabled ? '0' : '1';
    }

    function onPanelChange(event) {
        const input = event.target;
        if (!isElement(input) || input.tagName !== 'INPUT' || !input.dataset.key) return;
        const key = input.dataset.key;
        if (!(key in DEFAULT_SETTINGS)) return;
        settings[key] = !!input.checked;
        saveSettings();
        applySettingsChange(key);
    }

    function applySettingsChange(key) {
        applyCompactClass();
        refreshPanel();

        if (key === 'enabled') {
            if (!settings.enabled) {
                closeChatActions();
                screen.hide();
                screen.setEnabled(false);
                quality.stop();
            } else {
                screen.setEnabled(getRoomId() && settings.screenActions);
                if (getRoomId() && settings.autoQuality) quality.start(getRoomId(), true);
            }
        }

        if (key === 'screenActions') {
            screen.setEnabled(settings.enabled && settings.screenActions && getRoomId());
        }

        if (key === 'hoverActions' && (!settings.enabled || !settings.hoverActions)) {
            closeChatActions();
        }

        if (key === 'autoQuality') {
            if (settings.enabled && settings.autoQuality && getRoomId()) {
                quality.start(getRoomId(), true);
            } else {
                quality.stop();
            }
        }

        giftFilter.scan();
    }

    function openPanel() {
        if (!ensureHost()) return;
        refreshPanel();
        ui.panel.dataset.open = '1';
        positionPanel();
    }

    function closePanel() {
        if (ui.panel) ui.panel.dataset.open = '0';
    }

    function positionPanel() {
        if (!ui.panel || ui.panel.dataset.open !== '1') return;
        const panelWidth = ui.panel.offsetWidth || 252;
        const panelHeight = ui.panel.offsetHeight || 300;
        let left = 12;
        let top = Math.max(8, window.innerHeight - panelHeight - 64);
        try {
            const rect = ui.fab.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                left = rect.left;
                top = rect.top - panelHeight - 10;
                if (top < 8) top = rect.bottom + 10;
            }
        } catch (e) {
        }
        left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
        top = Math.max(8, Math.min(top, window.innerHeight - panelHeight - 8));
        ui.panel.style.left = Math.round(left) + 'px';
        ui.panel.style.top = Math.round(top) + 'px';
    }

    let toastTimer = 0;

    function showToast(message, duration) {
        if (!ensureHost()) {
            log(message);
            return;
        }
        ui.toast.textContent = message;
        ui.toast.dataset.show = '1';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastTimer = 0;
            if (ui.toast) ui.toast.dataset.show = '0';
        }, duration || 1800);
    }

    // ---------- 复制 ----------
    async function copyText(text) {
        const value = String(text == null ? '' : text);
        if (!value) return false;

        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(value, 'text');
                return true;
            }
        } catch (e) {
        }

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(value);
                return true;
            }
        } catch (e) {
        }

        let textarea = null;
        try {
            textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            return document.execCommand('copy');
        } catch (e) {
            return false;
        } finally {
            if (textarea) textarea.remove();
        }
    }

    // ---------- 弹幕悬停菜单 ----------
    function hoverActionsEnabled() {
        return !!(settings.enabled && settings.hoverActions && getRoomId());
    }

    function cancelHideChatActions() {
        if (chat.hideTimer) {
            clearTimeout(chat.hideTimer);
            chat.hideTimer = 0;
        }
    }

    function scheduleHideChatActions() {
        if (!chat.active || chat.hideTimer) return;
        chat.hideTimer = setTimeout(() => {
            chat.hideTimer = 0;
            closeChatActions();
        }, 380);
    }

    function cancelChatSwitch() {
        if (chat.switchTimer) {
            clearTimeout(chat.switchTimer);
            chat.switchTimer = 0;
        }
        chat.pendingItem = null;
    }

    function scheduleChatSwitch(item, anchorX) {
        cancelChatSwitch();
        chat.pendingItem = item;
        chat.pendingX = anchorX;
        chat.switchTimer = setTimeout(() => {
            chat.switchTimer = 0;
            const pending = chat.pendingItem;
            chat.pendingItem = null;
            if (!pending || !pending.isConnected || !isChatMessageItem(pending)) return;
            const data = extractChatData(pending);
            if (!data || !data.text) return;
            openChatActions(pending, data, chat.pendingX);
        }, 260);
    }

    function closeChatActions() {
        cancelHideChatActions();
        cancelChatSwitch();
        if (chat.active && chat.active.item) {
            try {
                chat.active.item.classList.remove('dyex-chat-active');
            } catch (e) {
            }
        }
        chat.active = null;
        if (ui.actions) {
            ui.actions.dataset.open = '0';
            ui.actions.style.visibility = 'hidden';
        }
        unfreezeChatList();
    }

    function openChatActions(item, data, anchorX) {
        cancelHideChatActions();
        cancelChatSwitch();
        closeChatActions();
        screen.hide();

        const list = findChatList(item);
        if (list) freezeChatList(list);

        chat.active = {
            item,
            text: data.text,
            hasEmoji: data.hasEmoji,
            anchorX: Number.isFinite(anchorX) ? anchorX : null
        };

        try {
            item.classList.add('dyex-chat-active');
        } catch (e) {
        }

        if (ui.plusBtn) {
            ui.plusBtn.title = data.hasEmoji
                ? '含自定义表情，将按文本内容发送（如 [赞]）'
                : '发送同样内容';
        }
        if (ui.actions) {
            ui.actions.style.visibility = 'hidden';
            ui.actions.dataset.open = '1';
            positionChatActions();
        }
    }

    function positionChatActions() {
        if (!chat.active || !ui.actions) return;
        const item = chat.active.item;
        if (!item || !item.isConnected) {
            closeChatActions();
            return;
        }
        let rect;
        try {
            rect = item.getBoundingClientRect();
        } catch (e) {
            closeChatActions();
            return;
        }
        if (rect.height < 1 || rect.bottom < 0 || rect.top > window.innerHeight) {
            closeChatActions();
            return;
        }

        ui.actions.style.visibility = 'hidden';
        ui.actions.dataset.open = '1';
        const menuWidth = ui.actions.offsetWidth || 100;
        const menuHeight = ui.actions.offsetHeight || 33;
        const anchorX = chat.active.anchorX == null ? rect.left + 4 : chat.active.anchorX;
        let left = anchorX - menuWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
        // 菜单紧贴弹幕行，鼠标往下/往上移动时不会先经过别的弹幕
        let top = rect.bottom;
        if (top + menuHeight > window.innerHeight - 8) top = rect.top - menuHeight;
        top = Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8));
        ui.actions.style.left = Math.round(left) + 'px';
        ui.actions.style.top = Math.round(top) + 'px';
        ui.actions.style.visibility = 'visible';
    }

    function onChatMouseOver(event) {
        if (!hoverActionsEnabled() || !ui.host) return;
        const target = event.target;
        if (!isElement(target)) return;

        if (ui.actions && ui.actions.contains(target)) {
            if (chat.active) {
                cancelHideChatActions();
                cancelChatSwitch();
            }
            return;
        }

        if ((ui.panel && ui.panel.contains(target)) || (ui.fab && ui.fab.contains(target))) {
            if (chat.active) scheduleHideChatActions();
            return;
        }

        const item = target.closest(SEL.chatItem);
        if (item) {
            if (chat.active && chat.active.item === item) {
                cancelHideChatActions();
                cancelChatSwitch();
                return;
            }
            if (!isChatMessageItem(item)) {
                if (chat.active) {
                    cancelChatSwitch();
                    scheduleHideChatActions();
                }
                return;
            }
            const data = extractChatData(item);
            if (data && data.text) {
                if (!chat.active) {
                    openChatActions(item, data, event.clientX);
                } else {
                    scheduleChatSwitch(item, event.clientX);
                }
                return;
            }
        }

        if (chat.active) {
            cancelChatSwitch();
            scheduleHideChatActions();
        }
    }

    // ---------- 路由 / 初始化 ----------
    function hookHistory() {
        for (const key of ['pushState', 'replaceState']) {
            try {
                const original = history[key];
                if (typeof original !== 'function' || original.__dyexWrapped) continue;
                const wrapped = function () {
                    const result = original.apply(this, arguments);
                    queueRouteCheck();
                    return result;
                };
                wrapped.__dyexWrapped = true;
                history[key] = wrapped;
            } catch (e) {
            }
        }
        window.addEventListener('popstate', queueRouteCheck);
    }

    let routeTimer = 0;

    function queueRouteCheck() {
        if (!ui.booted) return;
        if (routeTimer) return;
        routeTimer = setTimeout(() => {
            routeTimer = 0;
            checkRoute(false);
        }, 60);
    }

    function checkRoute(force) {
        const href = location.href;
        const roomId = getRoomId();
        const hrefChanged = href !== ui.href;
        const roomChanged = roomId !== ui.roomId;
        if (!force && !hrefChanged && !roomChanged) {
            ensureHostMounted();
            return;
        }

        const hadRoom = ui.inRoom;
        ui.href = href;
        ui.roomId = roomId;
        ui.inRoom = !!roomId;

        applyCompactClass();

        if (ui.booted) {
            if (roomChanged) {
                closeChatActions();
                screen.hide();
                if (hadRoom || roomId) closePanel();
                setFabVisible();
                if (roomId && settings.enabled && settings.autoQuality) {
                    quality.start(roomId, true);
                } else {
                    quality.stop();
                }
                screen.setEnabled(roomId && settings.enabled && settings.screenActions);
            } else {
                setFabVisible();
                screen.setEnabled(roomId && settings.enabled && settings.screenActions);
            }
            refreshPanel();
        }

        giftFilter.scan();
        ensureHostMounted();
    }

    function bindGlobalEvents() {
        document.addEventListener('mousemove', (event) => screen.onMove(event), { capture: true, passive: true });

        document.addEventListener('pointerdown', (event) => {
            const target = event.target;
            if (!isElement(target)) return;
            if (target.closest(SEL.qualityLabel) || target.closest(SEL.qualityList)) {
                quality.markUserOverride();
            }
        }, true);

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            let handled = false;
            if (chat.active) {
                closeChatActions();
                handled = true;
            }
            if (screen.hover) {
                screen.hide();
                handled = true;
            }
            if (ui.panel && ui.panel.dataset.open === '1') {
                closePanel();
                handled = true;
            }
            if (handled) event.stopPropagation();
        }, true);

        document.addEventListener('pointerdown', (event) => {
            if (!ui.panel || ui.panel.dataset.open !== '1') return;
            const target = event.target;
            if (!isElement(target)) return;
            if (ui.panel.contains(target) || (ui.fab && ui.fab.contains(target))) return;
            closePanel();
        }, true);

        document.documentElement.addEventListener('mouseleave', () => {
            closeChatActions();
            screen.scheduleHide();
        }, true);
        window.addEventListener('blur', () => {
            closeChatActions();
            screen.hide();
        });
        window.addEventListener('resize', () => {
            if (chat.active) positionChatActions();
            screen.hide();
            if (ui.panel && ui.panel.dataset.open === '1') positionPanel();
        });
        window.addEventListener('scroll', () => {
            if (chat.active) positionChatActions();
            if (screen.hover) screen.reposition();
        }, true);

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                closeChatActions();
                screen.hide();
                closePanel();
            }
        });

        document.addEventListener('fullscreenchange', () => {
            closeChatActions();
            screen.hide();
            closePanel();
            mountHost();
        }, true);
    }

    function registerMenuCommand() {
        try {
            if (typeof GM_registerMenuCommand !== 'function') return;
            GM_registerMenuCommand('DouyinEx 设置', () => {
                boot();
                if (!ensureHost()) return;
                openPanel();
            });
        } catch (e) {
        }
    }

    function boot() {
        if (ui.booted) return;
        ui.booted = true;
        ensureHost();
        bindGlobalEvents();
        registerMenuCommand();
        screen.bind();
        checkRoute(true);
        setInterval(() => {
            applyCompactClass();
            if (chat.active && (!chat.active.item || !chat.active.item.isConnected)) {
                closeChatActions();
            }
            checkRoute(false);
            ensureHostMounted();
        }, 1200);
        setInterval(() => {
            if (ui.booted) giftFilter.scan();
        }, 650);
        log('已启动', VERSION);
    }

    // ---------- 启动 ----------
    installDanmakuWorkerHook();
    injectStyles();
    applyCompactClass();
    hookHistory();

    try {
        window.__DouyinEx = {
            __loaded: true,
            version: VERSION,
            settings,
            ui,
            chat,
            screen,
            giftFilter,
            quality,
            sender,
            boot,
            openPanel,
            closePanel,
            showToast,
            copyText,
            sendDanmaku,
            extractChatData,
            getRoomId,
            findChatInput,
            applyCompactClass,
            screenChannel: SCREEN_CHANNEL
        };
    } catch (e) {
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
