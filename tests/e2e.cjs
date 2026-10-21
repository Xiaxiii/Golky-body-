// 端到端测试：需要一个装好本插件、并用 tests/fake-ncm 替换网易云接口包的 SillyTavern 1.19.0。
// 用法见 tests/README.md
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const B = process.env.ST_URL || 'http://127.0.0.1:8123';
const OUT = process.env.OUT_DIR || __dirname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

(async () => {
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
  const ours = startupReqs.filter(u => /netease-player/.test(u)).map(u => u.replace(B, ''));
  console.log('startup requests for netease-player:', ours);
  check(ours.every(u => /manifest\.json|\/index\.js$/.test(u)), '启动阶段只请求 manifest.json 和 index.js');
  check(!ours.some(u => /api\/plugins/.test(u)), '启动阶段不调用插件接口');
  check(await page.$('#nep-bar') === null || await page.$eval('#nep-bar', el => el.hidden), '没有历史记录时不显示迷你播放条');

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
  const barSub = await page.$eval('#nep-bar .nep-sub', el => el.textContent);
  check(barSub === '酒馆 · 回复已完成', `迷你条显示 ${barSub}`);
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
  await page.click('#nep-bar .nep-play');
  await sleep(300);
  check(await page.evaluate(() => document.getElementById('nep-audio').paused), '迷你条暂停');
  await page.click('#nep-bar .nep-play');
  await sleep(500);
  check(await page.evaluate(() => !document.getElementById('nep-audio').paused), '迷你条继续');
  await page.click('#nep-bar .nep-next');
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
  const reloadReqs = [];
  const onReq2 = r => reloadReqs.push(r.url());
  page.on('request', onReq2);
  await page.reload();
  await page.waitForSelector('#nep-bar:not([hidden])', { timeout: 60000 });
  await sleep(2000);
  await closePopups();
  page.off('request', onReq2);
  const ours2 = reloadReqs.filter(u => /netease-player/.test(u)).map(u => u.replace(B, ''));
  check(ours2.every(u => /manifest\.json|\/index\.js$/.test(u)), `有历史记录时启动也只请求两个文件: ${JSON.stringify(ours2)}`);
  const bar = await page.evaluate(() => ({ title: document.querySelector('#nep-bar .nep-title').textContent, resume: !document.querySelector('#nep-bar .nep-resume').hidden }));
  check(bar.title === 'B' && bar.resume, `恢复后迷你条: ${JSON.stringify(bar)}`);
  await page.screenshot({ path: OUT + '/7-restored.png' });
  await page.click('#nep-bar .nep-resume');
  await page.waitForFunction(() => { const a = document.getElementById('nep-audio'); return a && a.src.includes('song12') && !a.paused; }, null, { timeout: 10000 });
  check(true, '点「继续播放」后接着放 song12');

  check(pageErrors.length === 0, `页面没有报错 ${JSON.stringify(pageErrors)}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
