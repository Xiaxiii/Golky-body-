// 播放引擎：队列、取地址、预取下一首、Media Session、状态记忆。
// 只用一个 <audio>，不经过 Web Audio（AudioContext 在 iOS 后台会被挂起）。
import {
    api, getAudio, unlock, isUnlocked, playSilence, isSilence,
    store, settings, KEYS, log, gen, genRecentlyActive, miniBar,
} from './index.js';

const MAX_FAIL_STREAK = 5;
const PAGE_SIZE = 200;

const state = {
    queue: [],
    index: -1,
    mode: 'loop', // loop 列表循环 | one 单曲循环 | shuffle 随机
    source: null, // { type: 'playlist', id, name, offset, hasMore }
};

let audio = null;
let current = null; // { track, info }
let prefetched = null; // { index, id, info, at }
let plannedNext = null; // { from, to }
let prefetching = false;
let loadingMore = false;
let playToken = 0;
let failStreak = 0;
let retriedCurrent = false;
let userPaused = false;
let pendingSeek = 0;
let savedPosition = 0;
let lastPositionSave = 0;
let lastPositionState = 0;
let lastSrcSetAt = 0;
let lastPrefetchAt = 0;
let autoResumes = [];
let history = [];
const listeners = new Set();

// ---------- 对外接口 ----------

export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function getState() {
    return {
        queue: state.queue,
        index: state.index,
        mode: state.mode,
        source: state.source,
        track: state.queue[state.index] || null,
        playing: isPlaying(),
        currentTime: current && !isSilence() ? audio.currentTime : savedPosition,
        duration: current && !isSilence() ? audio.duration : 0,
        trial: !!current?.info?.trial,
    };
}

export function isPlaying() {
    return !!audio && !!current && !isSilence() && !audio.paused;
}

/** 用一组歌替换队列并从 startIndex 开始播放。 */
export function playTracks(tracks, start = 0, source = null) {
    unlock();
    state.queue = tracks.slice();
    state.source = source;
    history = [];
    resetPrefetch();
    saveQueue();
    startIndex(Math.max(0, Math.min(start, state.queue.length - 1)), { reason: '点播' });
}

/** 插到当前曲目后面并立刻播放。 */
export function playNow(track) {
    unlock();
    const at = state.index >= 0 ? state.index + 1 : 0;
    state.queue.splice(at, 0, track);
    resetPrefetch();
    saveQueue();
    startIndex(at, { reason: '点播' });
}

export function enqueue(tracks) {
    state.queue.push(...tracks);
    resetPrefetch();
    saveQueue();
    emit();
    if (current) schedulePrefetch();
}

export function removeAt(i) {
    if (i < 0 || i >= state.queue.length || i === state.index) return;
    state.queue.splice(i, 1);
    if (i < state.index) state.index--;
    history = [];
    resetPrefetch();
    saveQueue();
    savePosition(true);
    emit();
    if (current) schedulePrefetch();
}

export function playIndex(i) {
    unlock();
    if (i < 0 || i >= state.queue.length) return;
    if (state.index >= 0) history.push(state.index);
    startIndex(i, { reason: '点播' });
}

export function toggle() {
    if (isPlaying()) {
        pause();
    } else {
        resume();
    }
}

export function pause() {
    userPaused = true;
    if (audio && !audio.paused) audio.pause();
    if (isSilence()) audio.pause();
    savePosition(true);
    miniBar.set({ playing: false });
    emit();
}

export function resume() {
    unlock();
    userPaused = false;
    if (!state.queue.length) {
        miniBar.set({ needTap: false, note: '队列是空的，先去点首歌' });
        return;
    }
    if (current && !isSilence() && audio.src) {
        audio.play().catch(onPlayRejected);
        return;
    }
    const i = state.index >= 0 ? state.index : 0;
    startIndex(i, { startAt: savedPosition, reason: '继续播放' });
}

export function next() {
    unlock();
    userPaused = false;
    if (!state.queue.length) return;
    const to = consumePlannedNext() ?? computeNext(state.index);
    if (state.index >= 0) history.push(state.index);
    startIndex(to, { reason: '下一首' });
}

export function prev() {
    unlock();
    userPaused = false;
    if (!state.queue.length) return;
    if (current && !isSilence() && audio.currentTime > 5) {
        audio.currentTime = 0;
        return;
    }
    const to = history.length ? history.pop() : (state.index - 1 + state.queue.length) % state.queue.length;
    startIndex(to, { reason: '上一首' });
}

export function seek(seconds) {
    if (!current || isSilence() || !Number.isFinite(seconds)) return;
    audio.currentTime = Math.max(0, seconds);
    updatePositionState(true);
}

export function setMode(mode) {
    if (!['loop', 'one', 'shuffle'].includes(mode)) return;
    state.mode = mode;
    if (audio && current && !isSilence()) audio.loop = mode === 'one';
    resetPrefetch();
    saveQueue();
    emit();
    if (current) schedulePrefetch();
}

/** 关闭播放器：停止播放、清空记忆。 */
export function stopAndClear() {
    playToken++;
    userPaused = true;
    if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.dataset.silent = '0';
        audio.load();
    }
    current = null;
    state.queue = [];
    state.index = -1;
    state.source = null;
    resetPrefetch();
    store.remove(KEYS.queue);
    store.remove(KEYS.now);
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }
    miniBar.set({ title: '', artist: '', playing: false, needTap: false, note: '' });
    miniBar.hide();
    emit();
}

export function refreshMetadata() {
    updateMetadata();
}

// ---------- 播放流程 ----------

async function startIndex(i, { startAt = 0, reason = '' } = {}) {
    const token = ++playToken;
    const track = state.queue[i];
    if (!track) return;
    userPaused = false;
    state.index = i;
    savedPosition = startAt;
    retriedCurrent = false;
    current = null;
    // 只记当前是第几首（写在 now 里），不重写整个队列：大歌单的队列有几百 KB
    savePosition(true, track, startAt);
    miniBar.set({ title: track.name, artist: track.ar, needTap: false, note: '' });
    updateMetadata(track);
    emit();

    let info = takePrefetched(i, track.id);
    if (!info) {
        // 取地址期间放静音，避免没声音时页面被挂起
        playSilence();
        try {
            info = await fetchUrl(track);
        } catch (error) {
            info = { url: null, error: error.message };
        }
        if (token !== playToken) return;
    }

    if (!info.url || (info.trial && settings.skipTrial)) {
        skipBroken(i, track, info);
        return;
    }

    current = { track, info };
    log('播放', `${track.name}${reason ? `（${reason}）` : ''}`);
    pendingSeek = startAt > 0 ? startAt : 0;
    setSource(info.url);
    // 取地址期间用户按了暂停，就只装好歌不播放
    if (!userPaused) {
        audio.play().catch(onPlayRejected);
    }
    emit();
}

function setSource(url) {
    lastSrcSetAt = Date.now();
    audio.dataset.silent = '0';
    audio.loop = state.mode === 'one';
    audio.src = url;
}

function onPlayRejected(error) {
    if (error?.name === 'AbortError') return;
    if (error?.name === 'NotAllowedError') {
        log('播放被系统拦截', '需要点一下');
        miniBar.set({ needTap: true, playing: false, note: '点「继续播放」' });
        emit();
        return;
    }
    log('播放失败', error?.message || error);
}

function skipBroken(i, track, info) {
    failStreak++;
    const why = !info.url
        ? (info.error || (track.st < 0 ? '无版权' : (track.fee === 1 ? '需要 VIP' : '取不到播放地址')))
        : '只有试听片段';
    log('跳过', `${track.name}：${why}`);
    if (document.visibilityState === 'visible') {
        globalThis.toastr?.warning(`${track.name}：${why}，已跳过`, '', { timeOut: 2500 });
    }
    if (failStreak >= Math.min(MAX_FAIL_STREAK, state.queue.length)) {
        failStreak = 0;
        audio.pause();
        log('停止', '连续多首无法播放');
        miniBar.set({ playing: false, note: '连续几首都放不了，已停止' });
        emit();
        return;
    }
    const to = computeNext(i, { skipping: true });
    history.push(i);
    startIndex(to, { reason: '跳过后' });
}

async function fetchUrl(track) {
    const data = await api('url', { id: track.id, level: settings.level });
    return { url: data.url, trial: data.trial, expi: data.expi || 1200, br: data.br, code: data.code, at: Date.now() };
}

function isFresh(info, marginSec = 90) {
    return !!info?.url && Date.now() - info.at < Math.max(60, (info.expi || 1200) - marginSec) * 1000;
}

function takePrefetched(i, id) {
    const p = prefetched;
    prefetched = null;
    if (p && p.index === i && p.id === id && isFresh(p.info)) return p.info;
    return null;
}

function resetPrefetch() {
    prefetched = null;
    plannedNext = null;
}

function computeNext(from, { skipping = false } = {}) {
    const n = state.queue.length;
    if (n <= 1) return 0;
    if (state.mode === 'shuffle') {
        let to = from;
        while (to === from) to = Math.floor(Math.random() * n);
        return to;
    }
    if (state.mode === 'one' && !skipping) return from;
    return (from + 1) % n;
}

function consumePlannedNext() {
    const p = plannedNext;
    plannedNext = null;
    return p && p.from === state.index && p.to < state.queue.length ? p.to : null;
}

function schedulePrefetch() {
    setTimeout(() => prefetch().catch(() => { }), 1500);
}

/** 当前曲目开始后预取下一首的地址；遇到放不了的往后再找几首。 */
async function prefetch() {
    if (!current || prefetching) return;
    lastPrefetchAt = Date.now();
    maybeLoadMore();
    if (state.mode === 'one' || state.queue.length < 2) return;
    prefetching = true;
    const token = playToken;
    try {
        let from = state.index;
        let to = plannedNext?.from === state.index ? plannedNext.to : computeNext(from);
        if (prefetched && prefetched.index === to && isFresh(prefetched.info, 120)) return;
        for (let tries = 0; tries < 4; tries++) {
            const track = state.queue[to];
            if (!track) return;
            let info;
            try {
                info = await fetchUrl(track);
            } catch {
                return;
            }
            if (token !== playToken) return;
            if (info.url && !(info.trial && settings.skipTrial)) {
                plannedNext = { from: state.index, to };
                prefetched = { index: to, id: track.id, info, at: Date.now() };
                return;
            }
            log('预取时跳过', `${track.name}：${info.url ? '只有试听片段' : '取不到地址'}`);
            from = to;
            to = computeNext(from, { skipping: true });
            if (to === state.index) return;
        }
    } finally {
        prefetching = false;
    }
}

/** 队列来自歌单且快放完时，接着加载下一页。 */
async function maybeLoadMore() {
    const src = state.source;
    if (!src || src.type !== 'playlist' || !src.hasMore || loadingMore) return;
    if (state.queue.length - state.index > 5 && state.mode !== 'shuffle') return;
    loadingMore = true;
    try {
        const data = await api('playlist/tracks', { id: src.id, offset: src.offset, limit: PAGE_SIZE });
        if (state.source !== src) return;
        state.queue.push(...data.tracks);
        src.offset += data.tracks.length;
        src.hasMore = data.hasMore && data.tracks.length > 0;
        saveQueue();
        emit();
    } catch (error) {
        log('加载歌单下一页失败', error.message);
    } finally {
        loadingMore = false;
    }
}

// ---------- <audio> 事件 ----------

function bindAudio() {
    audio.addEventListener('loadedmetadata', () => {
        if (isSilence()) return;
        if (pendingSeek > 0 && Number.isFinite(audio.duration) && pendingSeek < audio.duration - 2) {
            audio.currentTime = pendingSeek;
        }
        pendingSeek = 0;
        updatePositionState(true);
    });

    audio.addEventListener('playing', () => {
        if (isSilence() || !current) return;
        failStreak = 0;
        userPaused = false;
        miniBar.set({ playing: true, needTap: false, note: current.info.trial ? '试听片段' : '' });
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updatePositionState(true);
        emit();
        schedulePrefetch();
    });

    audio.addEventListener('pause', () => {
        // 换 src 时浏览器也可能发 pause，忽略
        if (isSilence() || !current || Date.now() - lastSrcSetAt < 1000) return;
        miniBar.set({ playing: false });
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        savePosition(true);
        emit();
        if (audio.ended) return;
        log('暂停', userPaused ? '手动' : '被系统或其他声音打断');
        maybeAutoResume();
    });

    audio.addEventListener('ended', () => {
        if (isSilence() || !current) return;
        log('播完', current.track.name);
        const to = consumePlannedNext() ?? computeNext(state.index);
        history.push(state.index);
        if (history.length > 100) history.shift();
        startIndex(to, { reason: '自动' });
    });

    audio.addEventListener('timeupdate', () => {
        if (isSilence() || !current) return;
        savePosition(false);
        updatePositionState(false);
        const left = audio.duration - audio.currentTime;
        if (left < 30 && state.mode !== 'one' && !prefetching && Date.now() - lastPrefetchAt > 10000
            && !(prefetched && isFresh(prefetched.info, 60))) {
            prefetch().catch(() => { });
        }
    });

    audio.addEventListener('error', () => {
        if (isSilence() || !current) return;
        const track = current.track;
        const position = audio.currentTime || 0;
        const message = audio.error?.message || `code ${audio.error?.code}`;
        if (!retriedCurrent) {
            retriedCurrent = true;
            log('加载失败，重新取地址', `${track.name}：${message}`);
            const token = playToken;
            playSilence();
            fetchUrl(track).then((info) => {
                if (token !== playToken) return;
                if (!info.url) {
                    skipBroken(state.index, track, info);
                    return;
                }
                current = { track, info };
                pendingSeek = position;
                setSource(info.url);
                audio.play().catch(onPlayRejected);
            }).catch((error) => {
                if (token === playToken) skipBroken(state.index, track, { url: null, error: error.message });
            });
            return;
        }
        skipBroken(state.index, track, { url: null, error: `播放出错（${message}）` });
    });
}

/** 生成完成前后被提示音之类打断时，自动接着放（20 秒内最多 2 次，避免和别的声音来回抢）。 */
function maybeAutoResume() {
    if (userPaused || !settings.autoResume || !genRecentlyActive(20000)) return;
    const now = Date.now();
    autoResumes = autoResumes.filter(t => now - t < 20000);
    if (autoResumes.length >= 2) return;
    autoResumes.push(now);
    setTimeout(() => {
        if (audio.paused && !userPaused && current && !isSilence()) {
            log('自动恢复播放');
            audio.play().catch(onPlayRejected);
        }
    }, 800);
}

// ---------- Media Session（锁屏 / 控制中心） ----------

function updateMetadata(track = state.queue[state.index]) {
    if (!('mediaSession' in navigator) || !track || typeof MediaMetadata === 'undefined') return;
    const label = gen.label;
    const artwork = track.pic
        ? [{ src: `${track.pic}?param=512y512`, sizes: '512x512', type: 'image/jpeg' }]
        : [];
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name,
            artist: label || track.ar,
            album: label ? track.ar : track.al,
            artwork,
        });
    } catch (error) {
        console.warn('[netease-player] metadata', error);
    }
}

function updatePositionState(force) {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const now = Date.now();
    if (!force && now - lastPositionState < 5000) return;
    lastPositionState = now;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
        navigator.mediaSession.setPositionState({
            duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(audio.currentTime, duration),
        });
    } catch {
        // 有些系统版本不支持
    }
}

function bindMediaSession() {
    if (!('mediaSession' in navigator)) {
        log('Media Session 不可用');
        return;
    }
    const handlers = {
        play: () => resume(),
        pause: () => pause(),
        stop: () => pause(),
        nexttrack: () => next(),
        previoustrack: () => prev(),
        seekto: (details) => seek(details.seekTime),
    };
    for (const [action, handler] of Object.entries(handlers)) {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch {
            // 不支持的动作忽略
        }
    }
}

// ---------- 记忆状态 ----------

function saveQueue() {
    store.set(KEYS.queue, {
        queue: state.queue,
        index: state.index,
        mode: state.mode,
        source: state.source,
    });
}

function savePosition(force, track = state.queue[state.index], position = null) {
    const now = Date.now();
    if (!force && now - lastPositionSave < 5000) return;
    lastPositionSave = now;
    if (!track) return;
    const pos = position ?? (current && !isSilence() ? audio.currentTime : savedPosition);
    savedPosition = pos || 0;
    store.set(KEYS.now, {
        id: track.id,
        index: state.index,
        title: track.name,
        artist: track.ar,
        position: savedPosition,
        savedAt: now,
    });
}

function restore() {
    const saved = store.get(KEYS.queue);
    if (saved && Array.isArray(saved.queue)) {
        state.queue = saved.queue.filter(t => t && t.id);
        state.index = Math.min(Number(saved.index) || 0, state.queue.length - 1);
        state.mode = ['loop', 'one', 'shuffle'].includes(saved.mode) ? saved.mode : 'loop';
        state.source = saved.source || null;
    }
    const now = store.get(KEYS.now);
    // 切歌时只更新 now，所以当前第几首以 now 为准
    const nowIndex = Number(now?.index);
    if (now && Number.isInteger(nowIndex) && state.queue[nowIndex]?.id === now.id) {
        state.index = nowIndex;
    }
    if (now && state.queue[state.index]?.id === now.id) {
        savedPosition = Number(now.position) || 0;
    }
}

function emit() {
    const snapshot = getState();
    for (const fn of listeners) {
        try {
            fn(snapshot);
        } catch (error) {
            console.error('[netease-player]', error);
        }
    }
}

let initialized = false;

export function init() {
    if (initialized) return;
    initialized = true;
    audio = getAudio();
    restore();
    bindAudio();
    bindMediaSession();
    gen.listeners.add(() => updateMetadata(current?.track));
    const persist = () => savePosition(true);
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persist();
    });
    if (state.queue.length && !isUnlocked()) {
        const track = state.queue[state.index];
        miniBar.set({ title: track?.name || '', artist: track?.ar || '', needTap: true });
    }
}
