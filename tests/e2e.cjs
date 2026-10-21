// 端到端测试：需要一个装好本插件、并用 tests/fake-ncm 替换网易云接口包的 SillyTavern 1.19.0。
// 用法见 tests/README.md
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const B = process.env.ST_URL || 'http://127.0.0.1:8123';
const OUT = process.env.OUT_DIR || __dirname;
// 和服务端里替身读的是同一个文件：写 1/2/3 改变「我喜欢的音乐」的曲目数
const FAKE_STATE = process.env.NEP_FAKE_STATE;
const setPlaylistVersion = (v) => require('fs').writeFileSync(FAKE_STATE, String(v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

(async () => {
  if (!FAKE_STATE) throw new Error('需要设置 NEP_FAKE_STATE（见 tests/README.md）');
  setPlaylistVersion(1);
  const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => { if (!/Internal S/.test(e.message)) { pageErrors.push(e.message); console.log('PAGEERROR', e.message); } });
  page.on('console', m => { if (m.type() === 'error' && /nep|netease/i.test(m.text())) console.log('CONSOLE', m.text()); });

  await page.goto(B + '/login');
  await page.evaluate(async () => {
    const t = (await (await fetch('/csrf-token')).json()).token;
    await fetch('/api/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t }, body: JSON.stringify({ handle: 'default-user' }) });
  });

  const startupReqs = [];
  const onReq = r => startupReqs.push(r.url());
  page.on('request', onReq);
  await page.goto(B + '/');
  await page.waitForSelector('#nep-menu-item', { state: 'attached', timeout: 60000 });
  await sleep(3000);
  page.off('request', onReq);
  // 扩展目录名随安装方式不同（Git 安装时是仓库名），所以按 third-party/ 匹配；测试用的酒馆里没有别的第三方扩展
  const isOurs = u => /\/third-party\/|netease-player/.test(u);
  const ours = startupReqs.filter(isOurs).map(u => u.replace(B, ''));
  console.log('startup requests for netease-player:', ours);
  check(ours.length >= 2 && ours.every(u => /manifest\.json|\/index\.js$/.test(u)), '启动阶段只请求 manifest.json 和 index.js');
  check(!ours.some(u => /api\/plugins/.test(u)), '启动阶段不调用插件接口');
  check(await page.$('#nep-bar') === null || await page.$eval('#nep-bar', el => el.hidden), '没有历史记录时不显示迷你播放条');
  const float0 = await page.evaluate(() => { const el = document.getElementById('nep-float'); const r = el?.getBoundingClientRect(); return el && { hidden: el.hidden, title: el.querySelector('.nep-title').textContent, right: Math.round(innerWidth - r.right), inView: r.top >= 0 && r.bottom <= innerHeight }; });
  check(float0 && !float0.hidden && float0.title === '网易云音乐' && float0.right <= 6 && float0.inView, `默认显示悬浮按钮，贴右边: ${JSON.stringify(float0)}`);

  const closePopups = async () => {
    for (let k = 0; k < 5 && await page.$('dialog.popup[open]'); k++) {
      await page.screenshot({ path: OUT + `/0-popup${k}.png` });
      const btn = await page.$('dialog.popup[open] .popup-button-cancel:visible, dialog.popup[open] .popup-button-ok:visible, dialog.popup[open] .popup-button-close:visible');
      if (btn) await btn.click(); else await page.keyboard.press('Escape');
      await sleep(800);
    }
  };
  await closePopups();
  // 打开面板
  await page.click('#extensionsMenuButton');
  await page.click('#nep-menu-item');
  await page.waitForSelector('#nep-panel:not([hidden])');
  check(true, '面板打开');
  await page.screenshot({ path: OUT + '/1-panel.png' });

  // 搜索并播放
  await page.fill('#nep-panel input[name=keywords]', '晴天');
  await page.click('#nep-panel form button[type=submit]');
  await page.waitForSelector('#nep-panel .nep-row');
  await page.screenshot({ path: OUT + '/2-search.png' });
  await page.click('#nep-panel .nep-row[data-i="0"] .nep-row-main');
  await page.waitForFunction(() => { const a = document.getElementById('nep-audio'); return a && a.src.includes('song1') && !a.paused; }, null, { timeout: 10000 });
  check(true, '点歌后开始播放 song1');
  const md = await page.evaluate(() => ({ t: navigator.mediaSession.metadata?.title, a: navigator.mediaSession.metadata?.artist }));
  check(md.t === '晴天' && md.a === '歌手1', `Media Session metadata: ${JSON.stringify(md)}`);

  // 生成状态
  await page.evaluate(() => SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false));
  await sleep(200);
  let artist = await page.evaluate(() => navigator.mediaSession.metadata?.artist);
  check(artist === '酒馆 · 正在生成…', `生成中 artist=${artist}`);
  await page.evaluate(() => SillyTavern.getContext().eventSource.emit('generation_ended', 3));
  await sleep(100);
  await page.evaluate(() => SillyTavern.getContext().eventSource.emit('message_received', 3, 'normal'));
  await sleep(200);
  artist = await page.evaluate(() => navigator.mediaSession.metadata?.artist);
  check(artist === '酒馆 · 回复已完成', `完成后 artist=${artist}`);
  const floatSub = await page.$eval('#nep-float .nep-sub', el => el.textContent);
  check(floatSub === '酒馆 · 回复已完成', `悬浮按钮显示 ${floatSub}`);
  // quiet 生成不算
  await page.evaluate(() => SillyTavern.getContext().eventSource.emit('generation_started', 'quiet', {}, false));
  // 备用信号：body data-generating
  await page.evaluate(() => { document.body.dataset.generating = 'true'; });
  await sleep(200);
  artist = await page.evaluate(() => navigator.mediaSession.metadata?.artist);
  check(artist === '酒馆 · 正在生成…', `data-generating 备用信号 artist=${artist}`);
  await page.evaluate(() => { delete document.body.dataset.generating; });
  await sleep(4500);
  artist = await page.evaluate(() => navigator.mediaSession.metadata?.artist);
  check(artist === '酒馆 · 生成已结束', `备用信号结束 artist=${artist}`);

  // 加入 VIP 歌（取不到地址），song1 播完后应跳过它并停在无可播
  // 登录
  await page.click('#nep-panel .nep-tabs button[data-tab=settings]');
  await page.click('#nep-panel [data-act=qr-start]');
  await page.waitForSelector('#nep-panel .nep-qr');
  await page.screenshot({ path: OUT + '/3-qr.png' });
  await page.waitForFunction(() => document.querySelector('#nep-panel')?.textContent.includes('测试用户'), null, { timeout: 15000 });
  check(true, '扫码登录流程完成，显示昵称');

  // 歌单 -> 播放全部（11,12 正常，13 返回 460）
  await page.click('#nep-panel .nep-tabs button[data-tab=playlists]');
  await page.click('#nep-panel [data-act=open-playlist]');
  await page.waitForSelector('#nep-panel [data-act=play-all]');
  await page.waitForFunction(() => document.querySelectorAll('#nep-panel .nep-row').length >= 3);
  await page.screenshot({ path: OUT + '/4-playlist.png' });
  await page.click('#nep-panel [data-act=play-all]');
  await page.waitForFunction(() => document.getElementById('nep-audio').src.includes('song11') && !document.getElementById('nep-audio').paused, null, { timeout: 10000 });
  check(true, '播放全部从 song11 开始');
  // 记录 song11 -> song12 切换时有没有经过静音
  await page.evaluate(() => {
    window.__srcs = [];
    const a = document.getElementById('nep-audio');
    new MutationObserver(() => window.__srcs.push(a.src.slice(-12))).observe(a, { attributes: true, attributeFilter: ['src'] });
  });
  await page.waitForFunction(() => document.getElementById('nep-audio').src.includes('song12') && !document.getElementById('nep-audio').paused, null, { timeout: 10000 });
  const srcs = await page.evaluate(() => window.__srcs);
  check(srcs.length === 1 && srcs[0].includes('song12'), `11→12 直接切换（预取生效），src 变化: ${JSON.stringify(srcs)}`);
  // 12 结束 -> 13 预取失败(460) -> 跳到 11（列表循环）
  await page.waitForFunction(() => document.getElementById('nep-audio').src.includes('song11'), null, { timeout: 15000 });
  check(true, '13 取不到地址被跳过，循环回 11');

  // 暂停 / 继续
  await page.click('#nep-float .nep-play');
  await sleep(300);
  check(await page.evaluate(() => document.getElementById('nep-audio').paused), '悬浮按钮暂停');
  await page.click('#nep-float .nep-play');
  await sleep(500);
  check(await page.evaluate(() => !document.getElementById('nep-audio').paused), '悬浮按钮继续');
  await page.click('#nep-panel .nep-next');
  await page.waitForFunction(() => document.getElementById('nep-audio').src.includes('song12'), null, { timeout: 10000 });
  check(true, '下一首');
  await sleep(1200);
  await page.click('#nep-panel .nep-tabs button[data-tab=queue]');
  await page.screenshot({ path: OUT + '/5-queue.png' });
  await page.click('#nep-panel .nep-tabs button[data-tab=settings]');
  await page.screenshot({ path: OUT + '/6-settings.png', fullPage: false });
  const logText = await page.$eval('#nep-panel .nep-log', el => el.textContent);
  console.log('---- 事件日志 ----\n' + logText.split('\n').slice(0, 25).join('\n'));

  // 刷新页面：恢复队列，需要点继续播放
  await page.evaluate(() => document.getElementById('nep-audio').pause());
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  // 只记新页面发出的请求：旧页面在跳转前可能还有预取请求没发完
  const reloadReqs = [];
  let navigated = false;
  const onNav = f => { if (f === page.mainFrame()) navigated = true; };
  const onReq2 = r => { if (navigated) reloadReqs.push(r.url()); };
  page.on('framenavigated', onNav);
  page.on('request', onReq2);
  await page.reload();
  await page.waitForSelector('#nep-float:not([hidden])', { timeout: 60000 });
  await sleep(2000);
  await closePopups();
  page.off('request', onReq2);
  page.off('framenavigated', onNav);
  const ours2 = reloadReqs.filter(isOurs).map(u => u.replace(B, ''));
  check(ours2.every(u => /manifest\.json|\/index\.js$/.test(u)), `有历史记录时启动也只请求两个文件: ${JSON.stringify(ours2)}`);
  const fl = await page.evaluate(() => ({ title: document.querySelector('#nep-float .nep-title').textContent, sub: document.querySelector('#nep-float .nep-sub').textContent }));
  check(fl.title === 'B' && fl.sub === '点 ▶ 继续播放', `恢复后悬浮按钮: ${JSON.stringify(fl)}`);
  await page.screenshot({ path: OUT + '/7-restored.png' });
  await page.click('#nep-float .nep-play');
  await page.waitForFunction(() => { const a = document.getElementById('nep-audio'); return a && a.src.includes('song12') && !a.paused; }, null, { timeout: 10000 });
  check(true, '点悬浮按钮的播放键后接着放 song12');

  // ---------- 悬浮按钮：拖动、点击展开/收起 ----------
  const panelOpen = () => page.evaluate(() => !!document.querySelector('#nep-panel:not([hidden])'));
  const rectOf = () => page.$eval('#nep-float', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const r0 = await rectOf();
  await page.mouse.move(r0.x + 20, r0.y + r0.h / 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(r0.x + 20 - 15 * k, r0.y + r0.h / 2 - 25 * k);
  await page.mouse.up();
  await sleep(300);
  const r1 = await rectOf();
  const savedPos = await page.evaluate(() => JSON.parse(localStorage.getItem('nep:v1:float-pos')));
  check(Math.abs(r1.x - (r0.x - 150)) < 3 && Math.abs(r1.y - (r0.y - 250)) < 3, `拖动后位置 ${JSON.stringify(r0)} → ${JSON.stringify(r1)}`);
  check(savedPos && savedPos.x < 1 && savedPos.y < 0.85, `拖动后位置已保存 ${JSON.stringify(savedPos)}`);
  check(!(await panelOpen()) && await page.evaluate(() => !document.getElementById('nep-audio').paused), '拖动不会触发展开或暂停');
  // 手机上是触摸：用 CDP 发真正的触摸事件再拖一次
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const t0 = { x: r1.x + 20, y: r1.y + r1.h / 2 };
  await touch('touchStart', t0.x, t0.y);
  for (let k = 1; k <= 8; k++) await touch('touchMove', t0.x + 10 * k, t0.y + 20 * k);
  await touch('touchEnd');
  await sleep(300);
  const r2 = await rectOf();
  check(Math.abs(r2.x - (r1.x + 80)) < 3 && Math.abs(r2.y - (r1.y + 160)) < 3, `触摸拖动 ${JSON.stringify(r1)} → ${JSON.stringify(r2)}`);
  check(!(await panelOpen()), '触摸拖动不会触发展开');
  await page.tap('#nep-float .nep-play');
  await sleep(300);
  check(await page.evaluate(() => document.getElementById('nep-audio').paused), '触摸点播放键暂停');
  await page.tap('#nep-float .nep-play');
  await sleep(500);
  check(await page.evaluate(() => !document.getElementById('nep-audio').paused), '触摸点播放键继续');
  await page.tap('#nep-float .nep-info');
  await page.waitForSelector('#nep-panel:not([hidden])');
  check(true, '点悬浮按钮展开面板');
  await page.screenshot({ path: OUT + '/8-float-panel.png' });

  // ---------- 歌单刷新 ----------
  // 打开面板时已经后台检查过一次歌单（已登录），切过去直接有数据
  await page.click('#nep-panel .nep-tabs button[data-tab=playlists]');
  await page.waitForFunction(() => document.querySelector('#nep-panel .nep-row[data-act=open-playlist] .nep-row-sub')?.textContent.startsWith('3 首'), null, { timeout: 5000 });
  check(true, '歌单列表 3 首');
  setPlaylistVersion(2); // 在网易云 App 里加了一首
  const cached = await page.evaluate(async () => {
    const res = await fetch('/api/plugins/netease-player/playlists', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: '{}' });
    return (await res.json()).playlists[0].count;
  });
  check(cached === 3, `不带 fresh 时走插件缓存，仍是 ${cached} 首`);
  await page.click('#nep-panel [data-act=refresh-playlists]');
  await page.waitForFunction(() => document.querySelector('#nep-panel .nep-row[data-act=open-playlist] .nep-row-sub')?.textContent.startsWith('4 首'), null, { timeout: 5000 });
  check(true, '点「刷新」跳过缓存，歌单列表变成 4 首');
  await page.click('#nep-panel [data-act=open-playlist]');
  await page.waitForFunction(() => document.querySelectorAll('#nep-panel .nep-row').length === 4, null, { timeout: 5000 });
  check(true, '刷新列表后打开歌单拿到 4 首（曲目缓存也作废了）');
  setPlaylistVersion(3);
  await page.click('#nep-panel [data-act=refresh-playlist]');
  await page.waitForFunction(() => document.querySelectorAll('#nep-panel .nep-row').length === 5 && document.querySelector('#nep-panel').textContent.includes('（5）'), null, { timeout: 5000 });
  check(true, '歌单里点「刷新」拿到 5 首，标题里的曲目数也更新');
  await page.screenshot({ path: OUT + '/9-playlist-refreshed.png' });
  // 收起，在 App 里又删了一首；过了检查间隔再打开面板，自动发现变化
  setPlaylistVersion(2);
  await page.click('#nep-float .nep-info');
  await sleep(300);
  check(!(await panelOpen()), '再点悬浮按钮收起面板');
  await sleep(10500);
  await page.click('#nep-float .nep-info');
  await page.waitForFunction(() => document.querySelectorAll('#nep-panel .nep-row').length === 4 && document.querySelector('#nep-panel').textContent.includes('（4）'), null, { timeout: 5000 });
  check(true, '打开面板时自动检查到歌单变化并重新加载（5 → 4 首）');

  // ---------- 常驻入口设置 ----------
  await page.click('#nep-panel .nep-tabs button[data-tab=settings]');
  await page.selectOption('#nep-panel select[data-setting=entry]', 'bar');
  await sleep(200);
  let vis = await page.evaluate(() => ({ bar: !!document.querySelector('#nep-bar:not([hidden])'), float: !!document.querySelector('#nep-float:not([hidden])') }));
  check(vis.bar && !vis.float, `切到迷你播放条: ${JSON.stringify(vis)}`);
  await page.screenshot({ path: OUT + '/10-entry-bar.png' });
  await page.selectOption('#nep-panel select[data-setting=entry]', 'off');
  await sleep(200);
  vis = await page.evaluate(() => ({ bar: !!document.querySelector('#nep-bar:not([hidden])'), float: !!document.querySelector('#nep-float:not([hidden])') }));
  check(!vis.float, `关闭常驻入口后悬浮按钮隐藏: ${JSON.stringify(vis)}`);
  await page.click('#nep-panel [data-act=shutdown]');
  await sleep(300);
  vis = await page.evaluate(() => ({ bar: !!document.querySelector('#nep-bar:not([hidden])'), float: !!document.querySelector('#nep-float:not([hidden])') }));
  check(!vis.bar && !vis.float, `关闭常驻入口 + 停止并关闭后什么都不显示: ${JSON.stringify(vis)}`);
  await page.reload();
  await page.waitForSelector('#nep-menu-item', { state: 'attached', timeout: 60000 });
  await sleep(1500);
  vis = await page.evaluate(() => ({ bar: !!document.querySelector('#nep-bar:not([hidden])'), float: !!document.querySelector('#nep-float:not([hidden])') }));
  check(!vis.bar && !vis.float, `刷新页面后设置仍然生效: ${JSON.stringify(vis)}`);

  check(pageErrors.length === 0, `页面没有报错 ${JSON.stringify(pageErrors)}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
