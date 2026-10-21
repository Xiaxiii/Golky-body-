// 网易云播放器 —— 启动时只运行这个文件：注册菜单项、监听生成事件、
// 有上次的播放记录时显示迷你播放条。不发任何网络请求。
// 播放逻辑（engine.js）和界面（panel.js）在用户点开后才加载。

const API_BASE = '/api/plugins/netease-player/';
const KEYS = {
    now: 'nep:v1:now',
    queue: 'nep:v1:queue',
    settings: 'nep:v1:settings',
    log: 'nep:v1:log',
};
const DEFAULT_SETTINGS = {
    skipTrial: true,
    statusMinutes: 3,
    autoResume: true,
    level: 'standard',
};

// ---------- localStorage（读写都可能抛错） ----------

export const store = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // 存储不可用时只是记不住状态
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch {
            // 同上
        }
    },
};

export const settings = { ...DEFAULT_SETTINGS, ...(store.get(KEYS.settings) || {}) };

export function saveSettings() {
    store.set(KEYS.settings, settings);
}

// ---------- 事件日志（用来在 iPhone 上确认事件到底有没有触发） ----------

const logEntries = store.get(KEYS.log, []) || [];
let logSaveTimer = null;

export function log(name, detail = '') {
    logEntries.push({ t: Date.now(), name, detail: String(detail || '') });
    if (logEntries.length > 60) {
        logEntries.splice(0, logEntries.length - 60);
    }
    if (!logSaveTimer) {
        logSaveTimer = setTimeout(() => {
            logSaveTimer = null;
            store.set(KEYS.log, logEntries);
        }, 2000);
    }
}

export function getLog() {
    return logEntries.slice();
}

export function clearLog() {
    logEntries.length = 0;
    store.remove(KEYS.log);
}

// ---------- 请求服务端插件 ----------

export async function api(path, body = {}) {
    const { getRequestHeaders } = SillyTavern.getContext();
    let res;
    try {
        res = await fetch(API_BASE + path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
    } catch (error) {
        throw new Error(`连不上酒馆服务器：${error?.message || error}`);
    }
    if (res.status === 404) throw new Error('服务端插件没有加载（404），请检查安装');
    if (res.status === 403 || res.status === 401) throw new Error('酒馆登录已失效，请刷新页面');
    if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`);
    const data = await res.json();
    if (!data.ok) {
        const error = new Error(data.error || '请求失败');
        error.needLogin = !!data.needLogin;
        throw error;
    }
    return data;
}

// ---------- 唯一的 <audio> 元素 ----------

let audio = null;
let silenceUrl = null;
let unlocked = false;

export function getAudio() {
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'nep-audio';
        audio.preload = 'auto';
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        document.body.appendChild(audio);
    }
    return audio;
}

// 1 秒的静音 WAV，在本地生成，不用请求文件
function getSilenceUrl() {
    if (!silenceUrl) {
        const rate = 8000;
        const n = rate;
        const buf = new ArrayBuffer(44 + n);
        const v = new DataView(buf);
        const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE');
        w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        w(36, 'data'); v.setUint32(40, n, true);
        new Uint8Array(buf, 44).fill(128);
        silenceUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }
    return silenceUrl;
}

export function isSilence() {
    return !!audio && audio.dataset.silent === '1';
}

/** 播放静音占位：切歌取地址的空档里保持页面不被挂起。 */
export function playSilence() {
    const a = getAudio();
    if (isSilence() && !a.paused) return;
    a.dataset.silent = '1';
    a.loop = true;
    a.src = getSilenceUrl();
    a.play().catch(() => { });
}

/**
 * 必须在用户点击的同步流程里调用：iOS 只允许用户手势触发第一次播放，
 * 之后同一个元素换 src 再 play() 就不用手势了。
 */
export function unlock() {
    if (unlocked) return;
    unlocked = true;
    playSilence();
}

export function isUnlocked() {
    return unlocked;
}

// ---------- 生成状态（显示在锁屏的副标题上） ----------

export const gen = {
    state: 'idle',
    label: null,
    lastEventAt: 0,
    listeners: new Set(),
};

let genGotMessage = false;
let genEndTimer = null;
let genRevertTimer = null;

function notifyGen() {
    for (const fn of gen.listeners) {
        try {
            fn();
        } catch (error) {
            console.error('[netease-player]', error);
        }
    }
    miniBar.render();
}

function setGenLabel(label, revertMs = 0) {
    gen.label = label;
    clearTimeout(genRevertTimer);
    if (label && revertMs > 0) {
        genRevertTimer = setTimeout(() => setGenLabel(null), revertMs);
    }
    notifyGen();
}

function genStart(source) {
    gen.lastEventAt = Date.now();
    clearTimeout(genEndTimer);
    if (gen.state === 'generating') return;
    gen.state = 'generating';
    genGotMessage = false;
    log('开始生成', source);
    setGenLabel('酒馆 · 正在生成…');
}

function genFinish(kind) {
    gen.lastEventAt = Date.now();
    clearTimeout(genEndTimer);
    if (gen.state === 'idle') return;
    gen.state = 'idle';
    const labels = {
        done: '酒馆 · 回复已完成',
        stopped: '酒馆 · 已停止生成',
        ended: '酒馆 · 生成已结束',
    };
    const visible = document.visibilityState === 'visible';
    const revertMs = visible ? 8000 : Math.max(1, Number(settings.statusMinutes) || 3) * 60 * 1000;
    log('生成结束', kind);
    setGenLabel(labels[kind] || labels.ended, revertMs);
}

/** 最近一段时间内有没有生成相关的动静（用于判断音乐是不是被提示音打断）。 */
export function genRecentlyActive(ms) {
    return gen.state === 'generating' || Date.now() - gen.lastEventAt < ms;
}

function bindGenerationEvents() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    const ignoredTypes = new Set(['quiet']);

    eventSource.on(eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun || ignoredTypes.has(type)) return;
        genStart(`事件 ${type || 'normal'}`);
    });

    let tokenLogged = false;
    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, () => {
        gen.lastEventAt = Date.now();
        if (gen.state !== 'generating') {
            tokenLogged = false;
            return;
        }
        if (!tokenLogged) {
            tokenLogged = true;
            log('收到流式 token');
        }
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (messageId, type) => {
        if (type === 'impersonate' || type === 'first_message') return;
        log('新消息', `#${messageId} ${type || ''}`);
        tokenLogged = false;
        if (gen.state === 'generating' || Date.now() - gen.lastEventAt < 5000) {
            genGotMessage = true;
            gen.state = 'generating';
            genFinish('done');
        }
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        log('事件 generation_ended');
        if (gen.state !== 'generating') return;
        // 流式生成时 ENDED 会早于 MESSAGE_RECEIVED，稍等一下再判断
        clearTimeout(genEndTimer);
        genEndTimer = setTimeout(() => {
            if (gen.state === 'generating') genFinish(genGotMessage ? 'done' : 'ended');
        }, 2000);
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        log('事件 generation_stopped');
        genFinish('stopped');
    });

    // 备用信号：酒馆在生成期间会给 body 加 data-generating
    new MutationObserver(() => {
        const generating = document.body.dataset.generating === 'true';
        if (generating && gen.state === 'idle') {
            genStart('界面状态');
        } else if (!generating && gen.state === 'generating') {
            clearTimeout(genEndTimer);
            genEndTimer = setTimeout(() => {
                if (gen.state === 'generating' && document.body.dataset.generating !== 'true') {
                    genFinish(genGotMessage ? 'done' : 'ended');
                }
            }, 4000);
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-generating'] });

    document.addEventListener('visibilitychange', () => {
        log(document.visibilityState === 'visible' ? '回到页面' : '离开页面');
        if (document.visibilityState === 'visible' && gen.label && gen.state === 'idle') {
            setGenLabel(gen.label, 3000);
        }
    });
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) log('页面从缓存恢复');
    });
}

// ---------- 懒加载 ----------

let enginePromise = null;
let panelPromise = null;
let engineModule = null;

export function loadEngine() {
    if (!enginePromise) {
        enginePromise = import('./engine.js').then((m) => {
            m.init();
            engineModule = m;
            return m;
        });
        enginePromise.catch(() => {
            enginePromise = null;
        });
    }
    return enginePromise;
}

export function loadPanel() {
    if (!panelPromise) {
        panelPromise = Promise.all([loadEngine(), import('./panel.js')]).then(([, m]) => m);
        panelPromise.catch(() => {
            panelPromise = null;
        });
    }
    return panelPromise;
}

function reportLoadError(error) {
    console.error('[netease-player]', error);
    globalThis.toastr?.error(`播放器加载失败：${error?.message || error}`);
}

export async function openPanel() {
    miniBar.show();
    try {
        const panel = await loadPanel();
        panel.open();
    } catch (error) {
        reportLoadError(error);
    }
}

// ---------- 迷你播放条 ----------

const CSS = `
#nep-bar{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;margin:0 0 2px;padding:2px 6px;
border:1px solid var(--SmartThemeBorderColor);border-radius:10px;background:var(--SmartThemeBlurTintColor);
color:var(--SmartThemeBodyColor);backdrop-filter:blur(var(--SmartThemeBlurStrength,0));font-size:0.9em;white-space:nowrap}
#nep-bar[hidden]{display:none}
#nep-bar .nep-info{flex:1;min-width:0;overflow:hidden;line-height:1.25;padding:2px 0;cursor:pointer}
#nep-bar .nep-title,#nep-bar .nep-sub{overflow:hidden;text-overflow:ellipsis}
#nep-bar .nep-sub{opacity:.7;font-size:.85em}
#nep-bar .nep-sub.nep-gen{opacity:1;color:var(--SmartThemeQuoteColor)}
#nep-bar button{flex:none;width:36px;height:34px;border:0;border-radius:8px;background:transparent;color:inherit;
font-size:1.05em;cursor:pointer;-webkit-tap-highlight-color:transparent}
#nep-bar button:active{background:var(--SmartThemeBorderColor)}
#nep-bar .nep-resume{width:auto;padding:0 10px;border:1px solid var(--SmartThemeBorderColor);font-size:.9em}
`;

export const miniBar = {
    el: null,
    title: '',
    artist: '',
    playing: false,
    needTap: false,
    note: '',

    ensure() {
        if (this.el) return this.el;
        const style = document.createElement('style');
        style.id = 'nep-style';
        style.textContent = CSS;
        document.head.appendChild(style);

        const el = document.createElement('div');
        el.id = 'nep-bar';
        el.hidden = true;
        el.innerHTML = `
            <div class="nep-info" title="展开播放器"><div class="nep-title"></div><div class="nep-sub"></div></div>
            <button type="button" class="nep-resume" hidden>继续播放</button>
            <button type="button" class="nep-play fa-solid fa-play" title="播放/暂停"></button>
            <button type="button" class="nep-next fa-solid fa-forward-step" title="下一首"></button>
            <button type="button" class="nep-open fa-solid fa-chevron-up" title="展开"></button>`;
        const form = document.getElementById('send_form');
        if (form?.parentElement) {
            form.parentElement.insertBefore(el, form);
        } else {
            document.body.appendChild(el);
        }

        // 播放类按钮：播放逻辑已加载就同步调用（保持在用户手势里）；
        // 没加载时先同步解锁音频，再去加载
        const withEngine = (fn) => () => {
            if (engineModule) {
                fn(engineModule);
                return;
            }
            unlock();
            loadEngine().then(fn).catch(reportLoadError);
        };
        el.querySelector('.nep-play').addEventListener('click', withEngine(e => e.toggle()));
        el.querySelector('.nep-resume').addEventListener('click', withEngine(e => e.resume()));
        el.querySelector('.nep-next').addEventListener('click', withEngine(e => e.next()));
        el.querySelector('.nep-open').addEventListener('click', () => openPanel());
        el.querySelector('.nep-info').addEventListener('click', () => openPanel());
        this.el = el;
        return el;
    },

    show() {
        this.ensure().hidden = false;
        this.render();
    },

    hide() {
        if (this.el) this.el.hidden = true;
    },

    set(patch) {
        Object.assign(this, patch);
        this.render();
    },

    render() {
        if (!this.el || this.el.hidden) return;
        this.el.querySelector('.nep-title').textContent = this.title || '网易云音乐';
        const sub = this.el.querySelector('.nep-sub');
        const genLabel = gen.label;
        sub.textContent = genLabel || this.note || this.artist || '点歌名展开';
        sub.classList.toggle('nep-gen', !!genLabel);
        const play = this.el.querySelector('.nep-play');
        play.classList.toggle('fa-play', !this.playing);
        play.classList.toggle('fa-pause', this.playing);
        this.el.querySelector('.nep-resume').hidden = !this.needTap;
    },
};

export { KEYS };

// ---------- 启动 ----------

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('nep-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'nep-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-music extensionsMenuExtensionButton"></div><span>网易云音乐</span>';
    item.addEventListener('click', () => openPanel());
    menu.appendChild(item);
}

function restoreMiniBar() {
    const now = store.get(KEYS.now);
    if (!now || !now.title) return;
    log('页面加载', `上次保存于 ${Math.round((Date.now() - (now.savedAt || 0)) / 60000)} 分钟前`);
    miniBar.set({ title: now.title, artist: now.artist || '', needTap: true, note: '点「继续播放」接着听' });
    miniBar.show();
}

addMenuItem();
bindGenerationEvents();
restoreMiniBar();
