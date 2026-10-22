// 展开面板：搜索、我的歌单、播放队列、账号与设置。点开播放器时才加载。
import { api, settings, saveSettings, getLog, clearLog, gen, miniBar, resetFloatPosition } from './index.js';
import * as engine from './engine.js';

const CSS = `
#nep-panel{position:fixed;z-index:2900;left:max(6px,env(safe-area-inset-left));right:max(6px,env(safe-area-inset-right));
top:calc(var(--topBarBlockSize,50px) + env(safe-area-inset-top) + 4px);height:min(68dvh,620px);max-width:640px;margin:0 auto;
display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--SmartThemeBorderColor);border-radius:12px;
background:var(--SmartThemeBlurTintColor);background:rgb(from var(--SmartThemeBlurTintColor) r g b);
color:var(--SmartThemeBodyColor);box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:15px;white-space:normal;overflow:hidden;
contain:layout style}
#nep-panel[hidden]{display:none}
#nep-panel *{box-sizing:border-box}
#nep-panel button:not(.fa-solid){font:inherit}
#nep-panel button{color:inherit;background:transparent;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;
padding:6px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent}
#nep-panel button:active{background:var(--SmartThemeBorderColor)}
#nep-panel button.nep-icon{border:0;width:40px;height:40px;padding:0;font-size:1.1em}
#nep-panel input[type=text],#nep-panel input[type=search],#nep-panel select{font:inherit;color:inherit;background:transparent;
border:1px solid var(--SmartThemeBorderColor);border-radius:8px;padding:6px 8px;min-width:0}
.nep-now{display:flex;align-items:center;gap:10px;padding:10px 10px 4px}
.nep-cover{width:48px;height:48px;border-radius:8px;flex:none;object-fit:cover;background:var(--SmartThemeBorderColor)}
.nep-now-text{flex:1;min-width:0;line-height:1.3}
.nep-now-title,.nep-now-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nep-now-sub{opacity:.7;font-size:.88em}
.nep-now-sub.nep-gen{opacity:1;color:var(--SmartThemeQuoteColor)}
.nep-progress{display:flex;align-items:center;gap:8px;padding:0 12px;font-size:.78em;opacity:.8;font-variant-numeric:tabular-nums}
.nep-progress input{flex:1;accent-color:var(--SmartThemeQuoteColor)}
.nep-controls{display:flex;justify-content:center;align-items:center;gap:6px;padding:2px 8px 6px}
.nep-controls .nep-silent.nep-on{color:var(--SmartThemeQuoteColor)}
.nep-tabs{display:flex;border-top:1px solid var(--SmartThemeBorderColor);border-bottom:1px solid var(--SmartThemeBorderColor)}
.nep-tabs button{flex:1;border:0!important;border-radius:0!important;padding:9px 0!important;opacity:.65}
.nep-tabs button.nep-active{opacity:1;box-shadow:inset 0 -2px 0 var(--SmartThemeQuoteColor)}
.nep-body{flex:1;min-height:0;contain:content;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:8px 10px calc(10px + env(safe-area-inset-bottom))}
.nep-row{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid color-mix(in srgb,var(--SmartThemeBorderColor) 60%,transparent);cursor:pointer}
.nep-row:last-child{border-bottom:0}
.nep-row.nep-current{color:var(--SmartThemeQuoteColor)}
.nep-row-main{flex:1;min-width:0}
.nep-row-title,.nep-row-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nep-row-sub{opacity:.65;font-size:.82em}
.nep-row img{width:40px;height:40px;border-radius:6px;object-fit:cover;flex:none;background:var(--SmartThemeBorderColor)}
.nep-badge{display:inline-block;font-size:.72em;padding:0 4px;margin-left:4px;border:1px solid currentColor;border-radius:4px;opacity:.75;vertical-align:1px}
.nep-bar{display:flex;gap:6px;align-items:center;margin-bottom:8px}
.nep-bar input{flex:1}
.nep-hint{opacity:.7;font-size:.88em;line-height:1.5;margin:6px 0}
.nep-error{color:#e66;font-size:.9em;margin:6px 0}
.nep-qr{display:block;width:200px;height:200px;margin:8px auto;background:#fff;border-radius:8px;padding:6px}
.nep-section{margin:4px 0 14px}
.nep-section h4{margin:0 0 6px;font-size:.95em}
.nep-check{display:flex;gap:8px;align-items:center;margin:8px 0}
.nep-more{height:1px}
.nep-log{font-size:.78em;line-height:1.5;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;opacity:.85;max-height:260px;overflow:auto}
`;

const state = {
    tab: 'search',
    search: { keywords: '', tracks: [], hasMore: false, offset: 0, loading: false, error: '' },
    playlists: null,
    playlistsError: '',
    playlistsLoading: false,
    playlist: null, // { meta, tracks, hasMore, loading, error }
    account: null,
    accountError: '',
    qr: null, // { key, img, url, status, message, startedAt }
};

let root = null;
let body = null;
let unsubscribe = null;
let qrTimer = null;
let progressTimer = null;
let seeking = false;
let playlistsCheckedAt = 0;

// 打开面板时自动检查歌单更新，短时间内反复开关只查一次
const AUTO_CHECK_INTERVAL = 10 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function badges(t) {
    let html = '';
    if (t.st < 0) html += '<span class="nep-badge">无版权</span>';
    else if (t.fee === 1) html += '<span class="nep-badge">VIP</span>';
    return html;
}

// ---------- 长列表分批渲染：先画 LIST_STEP 行，滑到底附近再接着画 ----------

const LIST_STEP = 60;
let list = null; // { key, items, row, shown }
let moreObserver = null;

/**
 * 只渲染前一批行，后面放一个占位元素，滚到附近时 showMore() 再追加。
 * 同一个 key 重新渲染时保留已经显示的行数，避免滚动位置跳回去。
 */
function lazyList(key, items, row, { hasMore = null, loadMore = null } = {}) {
    const prevShown = list?.key === key ? list.shown : 0;
    const shown = Math.min(items.length, Math.max(LIST_STEP, prevShown));
    list = { key, items, row, shown, hasMore, loadMore };
    let html = '';
    for (let i = 0; i < shown; i++) html += row(items[i], i);
    if (needMore()) html += '<div class="nep-more"></div>';
    return html;
}

/** 还有没画出来的行，或者服务端还有下一页。 */
function needMore() {
    return !!list && (list.shown < list.items.length || !!list.hasMore?.());
}

function watchMore() {
    const el = body.querySelector('.nep-more');
    moreObserver?.disconnect();
    if (!el) return;
    moreObserver ??= new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) showMore();
    }, { root: body, rootMargin: '0px 0px 600px 0px' });
    moreObserver.observe(el);
}

function showMore() {
    const el = body.querySelector('.nep-more');
    if (!el || !list) return;
    if (list.shown >= list.items.length) {
        // 已经画到底：去拉下一页，拉回来后 syncMore() 再接着画
        moreObserver.unobserve(el);
        if (list.hasMore?.()) list.loadMore?.();
        else el.remove();
        return;
    }
    const from = list.shown;
    list.shown = Math.min(list.items.length, from + LIST_STEP);
    let html = '';
    for (let i = from; i < list.shown; i++) html += list.row(list.items[i], i);
    el.insertAdjacentHTML('beforebegin', html);
    moreObserver.unobserve(el);
    if (needMore()) {
        // 重新观察：占位元素还在可见范围里时会马上再触发一次
        moreObserver.observe(el);
    } else {
        el.remove();
    }
}

/** 列表数据变多（拉到了下一页）后，补上占位元素并重新观察，不重画已有的行。 */
function syncMore() {
    const el = body.querySelector('.nep-more');
    if (needMore() && !el) {
        body.querySelector('.nep-list-foot')?.insertAdjacentHTML('beforebegin', '<div class="nep-more"></div>');
    } else if (!needMore() && el) {
        el.remove();
    }
    watchMore();
}

function trackRow(t, i, { current = false, extra = '' } = {}) {
    return `<div class="nep-row${current ? ' nep-current' : ''}" data-i="${i}">
        <div class="nep-row-main"><div class="nep-row-title">${esc(t.name)}${badges(t)}</div>
        <div class="nep-row-sub">${esc(t.ar)}${t.al ? ` · ${esc(t.al)}` : ''}</div></div>${extra}</div>`;
}

// ---------- 面板骨架 ----------

function build() {
    const style = document.createElement('style');
    style.id = 'nep-panel-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'nep-panel';
    root.hidden = true;
    root.innerHTML = `
        <div class="nep-now">
            <img class="nep-cover" alt="">
            <div class="nep-now-text"><div class="nep-now-title"></div><div class="nep-now-sub"></div></div>
            <button type="button" class="nep-icon fa-solid fa-xmark nep-close" title="收起"></button>
        </div>
        <div class="nep-progress"><span class="nep-cur">0:00</span><input type="range" min="0" max="1000" value="0" class="nep-seek"><span class="nep-dur">0:00</span></div>
        <div class="nep-controls">
            <button type="button" class="nep-icon nep-mode" title="播放模式"></button>
            <button type="button" class="nep-icon fa-solid fa-backward-step nep-prev" title="上一首"></button>
            <button type="button" class="nep-icon fa-solid fa-play nep-toggle" title="播放/暂停"></button>
            <button type="button" class="nep-icon fa-solid fa-forward-step nep-next" title="下一首"></button>
            <button type="button" class="nep-icon fa-solid fa-list nep-goqueue" title="播放队列"></button>
            <button type="button" class="nep-icon fa-solid fa-volume-xmark nep-silent" title="静音播放"></button>
        </div>
        <div class="nep-tabs">
            <button type="button" data-tab="search">搜索</button>
            <button type="button" data-tab="playlists">歌单</button>
            <button type="button" data-tab="queue">队列</button>
            <button type="button" data-tab="settings">账号/设置</button>
        </div>
        <div class="nep-body"></div>`;
    document.body.appendChild(root);
    body = root.querySelector('.nep-body');

    root.querySelector('.nep-close').addEventListener('click', close);
    root.querySelector('.nep-toggle').addEventListener('click', () => engine.toggle());
    root.querySelector('.nep-prev').addEventListener('click', () => engine.prev());
    root.querySelector('.nep-next').addEventListener('click', () => engine.next());
    root.querySelector('.nep-goqueue').addEventListener('click', () => switchTab('queue'));
    root.querySelector('.nep-silent').addEventListener('click', () => {
        if (engine.isSilentMode()) engine.stopSilent();
        else engine.startSilent();
    });
    root.querySelector('.nep-mode').addEventListener('click', () => {
        const order = ['loop', 'shuffle', 'one'];
        engine.setMode(order[(order.indexOf(engine.getState().mode) + 1) % order.length]);
    });
    const seek = root.querySelector('.nep-seek');
    seek.addEventListener('input', () => {
        seeking = true;
        const s = engine.getState();
        root.querySelector('.nep-cur').textContent = fmtTime((seek.value / 1000) * (s.duration || 0));
    });
    seek.addEventListener('change', () => {
        const s = engine.getState();
        if (s.duration) engine.seek((seek.value / 1000) * s.duration);
        seeking = false;
    });
    for (const tab of root.querySelectorAll('.nep-tabs button')) {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }
    body.addEventListener('click', onBodyClick);
    body.addEventListener('submit', onBodySubmit);
    body.addEventListener('change', onBodyChange);
}

export function open() {
    if (!root) build();
    root.hidden = false;
    unsubscribe?.();
    unsubscribe = engine.onChange(() => {
        renderNow();
        if (state.tab === 'queue') renderBody();
    });
    gen.listeners.add(renderNow);
    clearInterval(progressTimer);
    progressTimer = setInterval(renderProgress, 1000);
    renderNow();
    switchTab(state.tab);
    if (!state.account && !state.accountError) refreshAccount();
    autoCheckPlaylists();
}

export function isOpen() {
    return !!root && !root.hidden;
}

export function close() {
    if (!root) return;
    root.hidden = true;
    unsubscribe?.();
    unsubscribe = null;
    gen.listeners.delete(renderNow);
    clearInterval(progressTimer);
}

function switchTab(tab) {
    state.tab = tab;
    list = null;
    for (const b of root.querySelectorAll('.nep-tabs button')) {
        b.classList.toggle('nep-active', b.dataset.tab === tab);
    }
    if (tab === 'playlists' && !state.playlists && !state.playlistsError && !state.playlistsLoading) loadPlaylists();
    renderBody();
    body.scrollTop = 0;
}

// ---------- 正在播放 ----------

function renderNow() {
    if (!root || root.hidden) return;
    const s = engine.getState();
    const t = s.silent ? null : s.track;
    root.querySelector('.nep-now-title').textContent = s.silent ? '静音播放' : (t ? t.name : '还没有播放');
    const sub = root.querySelector('.nep-now-sub');
    const idle = s.silent ? '保持页面不被挂起，再点 🔇 回到音乐' : '去搜歌或打开歌单';
    sub.textContent = gen.label || (t ? `${t.ar}${s.trial ? '（试听片段）' : ''}` : idle);
    sub.classList.toggle('nep-gen', !!gen.label);
    const silentBtn = root.querySelector('.nep-silent');
    silentBtn.classList.toggle('nep-on', s.silent);
    silentBtn.title = s.silent ? '结束静音播放' : '静音播放';
    const cover = root.querySelector('.nep-cover');
    const pic = t?.pic ? `${t.pic}?param=120y120` : '';
    if (cover.dataset.src !== pic) {
        cover.dataset.src = pic;
        if (pic) cover.src = pic;
        else cover.removeAttribute('src');
    }
    const toggle = root.querySelector('.nep-toggle');
    const playing = s.playing || s.silentPlaying;
    toggle.classList.toggle('fa-play', !playing);
    toggle.classList.toggle('fa-pause', playing);
    const mode = root.querySelector('.nep-mode');
    const modes = { loop: ['fa-repeat', '列表循环'], shuffle: ['fa-shuffle', '随机播放'], one: ['fa-1', '单曲循环'] };
    mode.className = `nep-icon nep-mode fa-solid ${modes[s.mode][0]}`;
    mode.title = modes[s.mode][1];
    renderProgress();
}

function renderProgress() {
    if (!root || root.hidden || seeking) return;
    const s = engine.getState();
    root.querySelector('.nep-cur').textContent = fmtTime(s.currentTime);
    root.querySelector('.nep-dur').textContent = fmtTime(s.duration || (s.track?.dt || 0) / 1000);
    root.querySelector('.nep-seek').value = s.duration ? Math.round((s.currentTime / s.duration) * 1000) : 0;
}

// ---------- 各个标签页 ----------

function renderBody() {
    if (!body) return;
    const render = { search: renderSearch, playlists: renderPlaylists, queue: renderQueue, settings: renderSettings }[state.tab];
    body.innerHTML = render();
    watchMore();
}

function renderSearch() {
    const s = state.search;
    let html = `<form class="nep-bar" data-form="search">
        <input type="search" name="keywords" placeholder="歌名 / 歌手" value="${esc(s.keywords)}" enterkeyhint="search" autocomplete="off">
        <button type="submit">搜索</button></form>`;
    if (s.error) html += `<div class="nep-error">${esc(s.error)}</div>`;
    if (!s.tracks.length && !s.loading && !s.error) {
        html += '<div class="nep-hint">点一首歌：插到当前歌曲后面并立刻播放。点右边的 ＋：加到队列末尾。</div>';
    }
    html += lazyList('search', s.tracks, (t, i) => trackRow(t, i, {
        extra: `<button type="button" class="nep-icon fa-solid fa-plus" data-act="enqueue" data-i="${i}" title="加到队列"></button>`,
    }));
    if (s.loading) html += '<div class="nep-hint">搜索中…</div>';
    else if (s.hasMore) html += '<button type="button" data-act="search-more" style="width:100%;margin-top:8px">加载更多</button>';
    return html;
}

function renderPlaylists() {
    if (state.playlist) return renderPlaylistTracks();
    if (state.playlistsError) {
        return `<div class="nep-error">${esc(state.playlistsError)}</div>
            <button type="button" data-act="reload-playlists">重试</button>`;
    }
    if (!state.playlists) return '<div class="nep-hint">加载中…</div>';
    const head = `<div class="nep-bar"><div class="nep-hint" style="flex:1;margin:0">${state.playlists.length} 个歌单</div>
        ${refreshButton('refresh-playlists')}</div>`;
    if (!state.playlists.length) return `${head}<div class="nep-hint">没有歌单</div>`;
    return head + lazyList('playlists', state.playlists, (p, i) => `<div class="nep-row" data-act="open-playlist" data-i="${i}">
        ${p.cover ? `<img loading="lazy" src="${esc(p.cover)}?param=80y80" alt="">` : '<img alt="">'}
        <div class="nep-row-main"><div class="nep-row-title">${esc(p.name)}</div>
        <div class="nep-row-sub">${p.count} 首${p.mine ? '' : ' · 收藏'}</div></div></div>`);
}

function renderPlaylistTracks() {
    const pl = state.playlist;
    let html = `<div class="nep-bar">
        <button type="button" class="fa-solid fa-chevron-left" data-act="back" title="返回"></button>
        <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pl.meta.name)}（${pl.meta.count}）</div>
        ${refreshButton('refresh-playlist')}</div>
        <div class="nep-bar"><button type="button" data-act="play-all" style="flex:1">▶ 播放全部</button>
        <button type="button" data-act="shuffle-all" style="flex:1">随机播放</button></div>`;
    html += lazyList(`pl:${pl.meta.id}`, pl.tracks, (t, i) => trackRow(t, i), {
        // 滑到底自动拉下一页；出错后停下，等手动点「加载更多」
        hasMore: () => pl.hasMore && !pl.error,
        loadMore: () => loadPlaylistPage(),
    });
    return `${html}<div class="nep-list-foot">${playlistFoot(pl)}</div>`;
}

function playlistFoot(pl) {
    let html = pl.error ? `<div class="nep-error">${esc(pl.error)}</div>` : '';
    if (pl.loading) html += '<div class="nep-hint">加载中…</div>';
    else if (pl.hasMore) html += '<button type="button" data-act="playlist-more" style="width:100%;margin-top:8px">加载更多</button>';
    return html;
}

/**
 * 歌单页的「加载中/加载更多」和新拉到的歌只做局部更新，不重画整个列表。
 * 歌单页没在显示（或换了歌单）就什么都不做，下次切过去会整体渲染。
 */
function updatePlaylistView(pl) {
    if (state.tab !== 'playlists' || state.playlist !== pl || root.hidden) return;
    const foot = body.querySelector('.nep-list-foot');
    if (!foot || list?.key !== `pl:${pl.meta.id}` || list.items !== pl.tracks) {
        renderBody();
        return;
    }
    foot.innerHTML = playlistFoot(pl);
    const refresh = body.querySelector('[data-act=refresh-playlist]');
    if (refresh) refresh.outerHTML = refreshButton('refresh-playlist');
    syncMore();
}

function refreshButton(act) {
    const busy = state.playlistsLoading || !!state.playlist?.loading;
    return `<button type="button" data-act="${act}" ${busy ? 'disabled' : ''} title="跳过缓存，从网易云重新获取">
        <i class="fa-solid fa-rotate-right"></i> ${busy ? '刷新中…' : '刷新'}</button>`;
}

function renderQueue() {
    const s = engine.getState();
    if (!s.queue.length) return '<div class="nep-hint">队列是空的。</div>';
    const start = Math.max(0, s.index - 30);
    let html = `<div class="nep-hint">共 ${s.queue.length} 首${s.source?.hasMore ? '（歌单剩下的会自动接上）' : ''}。点歌名播放，点 × 移出队列。</div>`;
    if (start > 0) html += `<div class="nep-hint">…前面还有 ${start} 首</div>`;
    html += lazyList('queue', s.queue.slice(start), (t, k) => {
        const i = start + k;
        const current = i === s.index;
        return trackRow(t, i, {
            current,
            extra: current ? '<span class="fa-solid fa-volume-high" style="padding:0 12px"></span>'
                : `<button type="button" class="nep-icon fa-solid fa-xmark" data-act="remove" data-i="${i}" title="移出队列"></button>`,
        });
    });
    return html;
}

function renderAccount() {
    if (state.accountError) {
        return `<div class="nep-error">${esc(state.accountError)}</div><button type="button" data-act="refresh-account">重试</button>`;
    }
    if (!state.account) return '<div class="nep-hint">正在查询登录状态…</div>';
    if (state.account.loggedIn) {
        const vip = state.account.vipType > 0 ? '（VIP）' : '';
        return `<div class="nep-row" style="cursor:default">
            ${state.account.avatar ? `<img src="${esc(state.account.avatar)}?param=80y80" alt="">` : ''}
            <div class="nep-row-main"><div class="nep-row-title">${esc(state.account.nickname)}${vip}</div>
            <div class="nep-row-sub">已登录网易云</div></div>
            <button type="button" data-act="logout">退出</button></div>`;
    }
    const qr = state.qr;
    let html = '<div class="nep-hint">未登录时只能播放免费歌曲；VIP 歌曲需要登录 VIP 账号。</div>';
    if (!qr) {
        return `${html}<button type="button" data-act="qr-start">扫码登录</button>`;
    }
    if (qr.error) html += `<div class="nep-error">${esc(qr.error)}</div>`;
    if (qr.img) html += `<img class="nep-qr" src="${esc(qr.img)}" alt="登录二维码">`;
    html += `<div class="nep-hint"><b>手机自己的相机扫不到自己屏幕上的码。</b><br>
        1. 截图这个页面；<br>2. 打开网易云 App →「扫一扫」→ 右上角从相册选这张截图；<br>3. 在 App 里点确认登录，再回到这里。</div>
        <div class="nep-hint">状态：${esc(qr.message || '等待扫码…')}</div>
        <div class="nep-bar"><button type="button" data-act="qr-copy">复制登录链接</button>
        <button type="button" data-act="qr-start">换一张</button></div>`;
    if (qr.copyFailed) {
        html += `<div class="nep-hint">自动复制失败，请长按下面的链接手动复制：</div>
            <input type="text" readonly value="${esc(qr.url)}" style="width:100%">`;
    }
    return html;
}

function renderSettings() {
    const ms = 'mediaSession' in navigator ? '可用' : '不可用（锁屏不会显示歌名）';
    const log = getLog().slice().reverse().map((e) => {
        const d = new Date(e.t);
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        return `${time} ${e.name}${e.detail ? ` ${e.detail}` : ''}`;
    }).join('\n');
    return `
        <div class="nep-section"><h4>网易云账号</h4>${renderAccount()}</div>
        <div class="nep-section"><h4>常驻入口</h4>
            <label class="nep-check">显示
            <select data-setting="entry" data-kind="text">${[['float', '悬浮按钮（可拖动）'], ['bar', '输入框上方的迷你播放条'], ['off', '关闭']]
                .map(([v, label]) => `<option value="${v}" ${settings.entry === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            <div class="nep-hint">关闭后只能从魔法棒菜单打开；正在播放时输入框上方仍会显示迷你播放条。悬浮按钮按住可以拖到任意位置。</div>
            ${settings.entry === 'float' ? '<button type="button" data-act="float-reset">悬浮按钮回到默认位置</button>' : ''}
        </div>
        <div class="nep-section"><h4>播放</h4>
            <label class="nep-check"><input type="checkbox" data-setting="skipTrial" ${settings.skipTrial ? 'checked' : ''}>跳过只有试听片段的歌</label>
            <label class="nep-check"><input type="checkbox" data-setting="autoResume" ${settings.autoResume ? 'checked' : ''}>生成完成前后音乐被提示音打断时，自动接着放</label>
            <div class="nep-hint">不想听歌时点播放键旁边的 🔇「静音播放」：不出声，照样保持页面不被挂起，锁屏也照样显示生成状态。再点一次回到刚才的歌。</div>
        </div>
        <div class="nep-section"><h4>锁屏生成状态</h4>
            <label class="nep-check">「回复已完成」显示
            <select data-setting="statusMinutes">${[1, 3, 5, 10].map(n => `<option value="${n}" ${Number(settings.statusMinutes) === n ? 'selected' : ''}>${n} 分钟</option>`).join('')}</select>
            后恢复歌手名</label>
            <div class="nep-hint">回到酒馆页面时也会恢复。当前：${esc(gen.label || '无')}</div>
        </div>
        <div class="nep-section"><h4>诊断</h4>
            <div class="nep-hint">Media Session：${ms}</div>
            <div class="nep-hint">事件日志（只留最近 10 条，最新在上；用来确认生成事件有没有触发、音乐有没有被打断）：</div>
            <div class="nep-log">${esc(log || '（空）')}</div>
            <div class="nep-bar" style="margin-top:6px"><button type="button" data-act="log-refresh">刷新</button>
            <button type="button" data-act="log-clear">清空</button></div>
        </div>
        <div class="nep-section"><h4>关闭播放器</h4>
            <div class="nep-hint">停止播放、清空队列。常驻入口设为「关闭」时，迷你播放条也会隐藏。登录状态保留。</div>
            <button type="button" data-act="shutdown">停止并关闭</button>
        </div>`;
}

// ---------- 数据 ----------

async function doSearch(more = false) {
    const s = state.search;
    if (!s.keywords || s.loading) return;
    s.loading = true;
    s.error = '';
    if (!more) {
        s.tracks = [];
        s.offset = 0;
    }
    renderBody();
    try {
        const data = await api('search', { keywords: s.keywords, offset: s.offset, limit: 30 });
        s.tracks.push(...data.tracks);
        s.offset += data.tracks.length;
        s.hasMore = data.hasMore && data.tracks.length > 0;
    } catch (error) {
        s.error = error.message;
    }
    s.loading = false;
    if (state.tab === 'search') renderBody();
}

/**
 * 取歌单列表。fresh：让服务端跳过缓存直接问网易云。
 * quiet：后台检查用，失败时不打扰（除非正对着空白的歌单页）。
 * reloadOpen：不管有没有变化，都重新拉正打开的歌单。
 */
async function loadPlaylists({ fresh = false, quiet = false, reloadOpen = false } = {}) {
    if (state.playlistsLoading) return false;
    state.playlistsLoading = true;
    if (!quiet) state.playlistsError = '';
    if (state.tab === 'playlists' && !quiet) renderBody();
    let ok = false;
    try {
        const data = await api('playlists', fresh ? { fresh: true } : {});
        if (fresh) playlistsCheckedAt = Date.now();
        const unchanged = quiet && !state.playlistsError && JSON.stringify(state.playlists) === JSON.stringify(data.playlists);
        state.playlistsError = '';
        applyPlaylists(data.playlists, reloadOpen);
        ok = true;
        if (unchanged) {
            // 后台检查没发现变化：不重画，免得大歌单白白重排一遍
            state.playlistsLoading = false;
            return ok;
        }
    } catch (error) {
        if (!quiet || (!state.playlists && state.tab === 'playlists')) {
            state.playlistsError = error.needLogin ? '需要先登录网易云（在「账号/设置」里扫码）' : error.message;
        }
    }
    state.playlistsLoading = false;
    if (state.tab === 'playlists') renderBody();
    return ok;
}

/** 换上新的歌单列表；正打开的歌单如果曲目数或更新时间变了，就重新拉它的歌。 */
function applyPlaylists(list, reloadOpen = false) {
    state.playlists = list;
    const pl = state.playlist;
    const meta = pl && list.find(p => p.id === pl.meta.id);
    if (!meta) return;
    const changed = meta.count !== pl.meta.count || meta.updated !== pl.meta.updated;
    pl.meta = meta;
    if (changed || reloadOpen) reloadPlaylistTracks();
}

function autoCheckPlaylists() {
    if (state.account && !state.account.loggedIn) return;
    if (Date.now() - playlistsCheckedAt < AUTO_CHECK_INTERVAL) return;
    playlistsCheckedAt = Date.now();
    loadPlaylists({ fresh: true, quiet: true });
}

function reloadPlaylistTracks() {
    const meta = state.playlist?.meta;
    if (!meta) return;
    state.playlist = { meta, tracks: [], hasMore: true, loading: false, error: '', fresh: true };
    loadPlaylistPage();
}

async function loadPlaylistPage() {
    const pl = state.playlist;
    if (!pl || pl.loading) return;
    pl.loading = true;
    pl.error = '';
    if (pl.tracks.length) updatePlaylistView(pl);
    else if (state.tab === 'playlists') renderBody();
    try {
        const fresh = pl.fresh && !pl.tracks.length;
        const data = await api('playlist/tracks', { id: pl.meta.id, offset: pl.tracks.length, limit: 200, ...(fresh ? { fresh: true } : {}) });
        if (state.playlist !== pl) return;
        pl.tracks.push(...data.tracks);
        pl.hasMore = data.hasMore && data.tracks.length > 0;
    } catch (error) {
        pl.error = error.message;
    }
    pl.loading = false;
    updatePlaylistView(pl);
}

function playlistSource(pl) {
    return { type: 'playlist', id: pl.meta.id, name: pl.meta.name, offset: pl.tracks.length, hasMore: pl.hasMore };
}

async function refreshAccount() {
    state.accountError = '';
    try {
        state.account = await api('status');
    } catch (error) {
        state.accountError = error.message;
    }
    if (state.tab === 'settings') renderBody();
}

async function startQr() {
    clearTimeout(qrTimer);
    state.qr = { message: '正在获取二维码…' };
    renderBody();
    try {
        const data = await api('qr/start');
        state.qr = { key: data.key, img: data.qrimg, url: data.qrurl, message: '等待扫码…', startedAt: Date.now() };
        pollQr(data.key);
    } catch (error) {
        state.qr = { error: error.message, message: '获取二维码失败' };
    }
    if (state.tab === 'settings') renderBody();
}

function pollQr(key) {
    clearTimeout(qrTimer);
    qrTimer = setTimeout(async () => {
        const qr = state.qr;
        if (!qr || qr.key !== key) return;
        if (Date.now() - qr.startedAt > 5 * 60 * 1000) {
            qr.message = '二维码过期了，点「换一张」';
            if (state.tab === 'settings') renderBody();
            return;
        }
        try {
            const data = await api('qr/check', { key });
            const messages = {
                800: '二维码过期了，点「换一张」',
                801: '等待扫码…',
                802: '已扫码，请在网易云 App 里点确认',
                803: '登录成功',
            };
            qr.message = messages[data.status] || `${data.message || '未知状态'}（${data.status}）`;
            if (data.status === 803) {
                state.qr = null;
                state.account = null;
                state.playlists = null;
                state.playlistsError = '';
                globalThis.toastr?.success('网易云登录成功');
                await refreshAccount();
                return;
            }
            if (data.status === 800) {
                if (state.tab === 'settings') renderBody();
                return;
            }
        } catch (error) {
            qr.message = `查询失败：${error.message}`;
        }
        if (state.tab === 'settings' && !root.hidden) {
            const hint = [...body.querySelectorAll('.nep-hint')].find(el => el.textContent.startsWith('状态：'));
            if (hint) hint.textContent = `状态：${qr.message}`;
        }
        pollQr(key);
    }, 2000);
}

function copyText(text) {
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
        ta.remove();
        return ok;
    };
    // http 页面里没有 navigator.clipboard，只能用旧办法
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true, fallback);
    }
    return Promise.resolve(fallback());
}

// ---------- 交互 ----------

function onBodySubmit(e) {
    const form = e.target.closest('form[data-form=search]');
    if (!form) return;
    e.preventDefault();
    state.search.keywords = form.elements.keywords.value.trim();
    form.elements.keywords.blur();
    doSearch(false);
}

function onBodyChange(e) {
    const key = e.target.dataset?.setting;
    if (!key) return;
    const { type, value, checked, dataset } = e.target;
    settings[key] = type === 'checkbox' ? checked : (dataset.kind === 'text' ? value : Number(value));
    saveSettings();
    if (key === 'entry') {
        miniBar.apply();
        renderBody();
    }
}

function onBodyClick(e) {
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;
    const i = Number(actEl?.dataset.i ?? e.target.closest('.nep-row')?.dataset.i);

    switch (act) {
        case 'enqueue': {
            const t = state.search.tracks[i];
            if (t) {
                engine.enqueue([t]);
                globalThis.toastr?.info(`已加入队列：${t.name}`, '', { timeOut: 1500 });
            }
            return;
        }
        case 'search-more': return void doSearch(true);
        case 'reload-playlists':
            state.playlists = null;
            renderBody();
            return void loadPlaylists({ fresh: true });
        case 'refresh-playlists':
            loadPlaylists({ fresh: true }).then((ok) => {
                if (ok) globalThis.toastr?.success('歌单已刷新', '', { timeOut: 1500 });
            });
            return;
        case 'refresh-playlist':
            // 先刷新列表拿到最新曲目数，再从头拉这个歌单；列表刷新失败也照样重拉曲目
            loadPlaylists({ fresh: true, reloadOpen: true }).then((ok) => {
                if (!ok) reloadPlaylistTracks();
            });
            return;
        case 'open-playlist': {
            const meta = state.playlists?.[i];
            if (!meta) return;
            state.playlist = { meta, tracks: [], hasMore: true, loading: false, error: '' };
            loadPlaylistPage();
            body.scrollTop = 0;
            return;
        }
        case 'back':
            state.playlist = null;
            return void renderBody();
        case 'playlist-more': return void loadPlaylistPage();
        case 'play-all':
        case 'shuffle-all': {
            const pl = state.playlist;
            if (!pl?.tracks.length) return;
            engine.setMode(act === 'shuffle-all' ? 'shuffle' : (engine.getState().mode === 'shuffle' ? 'loop' : engine.getState().mode));
            const start = act === 'shuffle-all' ? Math.floor(Math.random() * pl.tracks.length) : 0;
            engine.playTracks(pl.tracks, start, playlistSource(pl));
            return;
        }
        case 'remove': return void engine.removeAt(i);
        case 'refresh-account':
            state.account = null;
            renderBody();
            return void refreshAccount();
        case 'logout':
            api('logout').catch(() => { }).finally(() => {
                state.account = null;
                state.playlists = null;
                state.playlist = null;
                refreshAccount();
            });
            return;
        case 'qr-start': return void startQr();
        case 'qr-copy':
            if (!state.qr?.url) return;
            copyText(state.qr.url).then((ok) => {
                if (ok) {
                    globalThis.toastr?.success('登录链接已复制');
                } else {
                    state.qr.copyFailed = true;
                    renderBody();
                }
            });
            return;
        case 'float-reset':
            resetFloatPosition();
            return;
        case 'log-refresh': return void renderBody();
        case 'log-clear':
            clearLog();
            return void renderBody();
        case 'shutdown':
            engine.stopAndClear();
            close();
            return;
    }

    // 点歌名
    const row = e.target.closest('.nep-row');
    if (!row || !Number.isFinite(i)) return;
    if (state.tab === 'search') {
        const t = state.search.tracks[i];
        if (t) engine.playNow(t);
    } else if (state.tab === 'playlists' && state.playlist) {
        engine.playTracks(state.playlist.tracks, i, playlistSource(state.playlist));
    } else if (state.tab === 'queue') {
        if (i !== engine.getState().index) engine.playIndex(i);
    }
}
