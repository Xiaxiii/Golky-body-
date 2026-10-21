// 生成可以直接粘贴进阿里云 Workbench 的安装命令：node tools/build-install.mjs
// 每段把文件打包成 tar.gz + base64（避免粘贴时中文、特殊字符被终端弄坏），
// 并用 sha256 校验，校验通过才解包。输出 INSTALL.md 和 install/steps.json。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ST = '/root/SillyTavern';
const PLUGIN_DIR = `${ST}/plugins/netease-player`;
const EXT_DIR = `${ST}/public/scripts/extensions/third-party/netease-player`;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/netease-player/package.json'), 'utf8')).version;

function pack(dir, files) {
    const tar = execFileSync('tar', [
        '--sort=name', '--mtime=2026-01-01 00:00Z', '--owner=0', '--group=0', '--numeric-owner',
        '-cf', '-', '-C', path.join(ROOT, dir), ...files,
    ]);
    const gz = execFileSync('gzip', ['-9n'], { input: tar });
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    return { sha, b64 };
}

function unpackCommand(name, dest, packed, files) {
    const tmp = `/tmp/nep-${name}.tgz`;
    return [
        `mkdir -p ${dest} && base64 -d > ${tmp} <<'NEP_EOF'`,
        packed.b64 + 'NEP_EOF',
        `echo "${packed.sha}  ${tmp}" | sha256sum -c --quiet && tar xzf ${tmp} -C ${dest} && rm -f ${tmp} && ls ${files.map(f => `${dest}/${f}`).join(' ')} >/dev/null && echo "${name} OK" || echo "${name} 失败：内容不完整，请重新复制整段再粘贴"`,
    ].join('\n');
}

const server = pack('server/netease-player', ['package.json', 'index.mjs', 'lib.mjs', 'selftest.mjs']);
const extA = pack('extension/netease-player', ['manifest.json', 'index.js', 'engine.js']);
const extB = pack('extension/netease-player', ['panel.js']);

const steps = [
    {
        id: 'check',
        title: '第 1 步：检查环境',
        note: '确认酒馆目录、Node 版本、服务端插件开关和 pm2。最后一行应是 STEP1 OK。',
        cmd: `cd ${ST} && node -v && grep -qE '^enableServerPlugins: *true' config.yaml && pm2 -v >/dev/null && echo "STEP1 OK" || echo "STEP1 失败：检查酒馆目录、config.yaml 里 enableServerPlugins 是否为 true"`,
    },
    {
        id: 'server',
        title: '第 2 步：写入服务端插件',
        note: '整段一起复制。最后一行应是 server OK。重装/升级时登录数据（data 目录）会保留。',
        cmd: unpackCommand('server', PLUGIN_DIR, server, ['index.mjs', 'lib.mjs', 'selftest.mjs', 'package.json']),
    },
    {
        id: 'npm',
        title: '第 3 步：安装网易云接口依赖（约 1～3 分钟）',
        note: '在后台安装，终端断开也会继续。等待时每 5 秒打一个点。最后一行应是 STEP3 OK。如果中途断开，重新连上后再粘贴一次这段即可（正在装就接着等，装失败了会重装）。',
        cmd: [
            `cd ${PLUGIN_DIR} && P=/root/nep-npm.pid && if [ ! -f node_modules/@neteasecloudmusicapienhanced/api/main.js ] && ! { [ -f $P ] && kill -0 "$(cat $P)" 2>/dev/null; }; then`,
            `  nohup sh -c 'A="--omit=dev --ignore-scripts --no-audit --no-fund"; npm install $A --registry=https://registry.npmmirror.com || { echo "镜像失败，改用默认源"; npm install $A; }; echo "EXIT $?"' > /root/nep-npm.log 2>&1 & echo $! > $P`,
            'fi',
            'for i in $(seq 1 72); do grep -q "^EXIT" /root/nep-npm.log 2>/dev/null && break; [ -f $P ] && kill -0 "$(cat $P)" 2>/dev/null || break; sleep 5; printf "."; done; echo',
            'tail -n 3 /root/nep-npm.log 2>/dev/null; [ -f node_modules/@neteasecloudmusicapienhanced/api/main.js ] && ! grep -q "^EXIT [1-9]" /root/nep-npm.log 2>/dev/null && echo "STEP3 OK" || echo "STEP3 还没好：把上面几行发给开发者"',
        ].join('\n'),
    },
    {
        id: 'selftest',
        title: '第 4 步：自检（服务器能不能连上网易云）',
        note: '应看到「搜索 OK」和 SELFTEST OK。如果提示 460：这是网易云拦了服务器自己的 IP，实际使用时会带上手机的 IP，可以先继续往下装，到手机上再看能不能搜歌。',
        cmd: `cd ${ST} && timeout 90 node plugins/netease-player/selftest.mjs`,
    },
    {
        id: 'extA',
        title: '第 5 步：写入前端扩展（1/2）',
        note: '整段一起复制。最后一行应是 ext1 OK。',
        cmd: unpackCommand('ext1', EXT_DIR, extA, ['manifest.json', 'index.js', 'engine.js']),
    },
    {
        id: 'extB',
        title: '第 6 步：写入前端扩展（2/2）',
        note: '整段一起复制。最后一行应是 ext2 OK。',
        cmd: unpackCommand('ext2', EXT_DIR, extB, ['panel.js']),
    },
    {
        id: 'restart',
        title: '第 7 步：重启酒馆',
        note: '会等酒馆启动完。应看到「[netease-player] 已加载」和 STEP7 OK。然后在 iPhone 上刷新酒馆页面。',
        cmd: [
            // 只看这次重启之后新写的日志
            `L=$(pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find(x=>x.name==="start");console.log(p.pm2_env.pm_out_log_path+" "+p.pm2_env.pm_err_log_path)') && set -- $L && O=$(stat -c %s $1) && E=$(stat -c %s $2)`,
            'pm2 restart start >/dev/null && for i in $(seq 1 40); do sleep 3; tail -c +$((O+1)) $1 | grep -q "netease-player\\] 已加载" && break; printf "."; done; echo',
            '{ tail -c +$((O+1)) $1; tail -c +$((E+1)) $2; } | grep -E "netease-player|Failed to load plugin" | tail -n 5',
            'tail -c +$((O+1)) $1 | grep -q "netease-player\\] 已加载" && echo "STEP7 OK" || echo "STEP7 没看到加载成功，把上面几行发给开发者"',
        ].join('\n'),
    },
];

const uninstall = {
    id: 'uninstall',
    title: '卸载（一条命令）',
    note: '删除服务端插件（含网易云登录数据）、前端扩展和安装日志，然后重启酒馆。iPhone 上残留的播放记录不影响使用。',
    cmd: `rm -rf ${PLUGIN_DIR} ${EXT_DIR} /root/nep-npm.log /root/nep-npm.pid /tmp/nep-*.tgz && pm2 restart start >/dev/null && echo "UNINSTALL OK"`,
};

const logs = {
    id: 'logs',
    title: '出问题时：查看插件日志',
    note: '把输出发给开发者。',
    cmd: 'pm2 logs start --lines 400 --nostream 2>&1 | grep -E "netease-player|\\[ERR\\]" | tail -n 30',
};

fs.mkdirSync(path.join(ROOT, 'install'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'install/steps.json'), JSON.stringify({ version: VERSION, steps, extra: [logs, uninstall] }, null, 2));

const md = [
    `# 安装命令（v${VERSION}）`,
    '',
    '> 本文件由 `node tools/build-install.mjs` 生成，不要手改。',
    '> 每一段在阿里云 Workbench 里**整段复制、粘贴、回车**，看到最后一行的 OK 再做下一步。',
    '> 长的几段是打包后的文件内容（base64），带校验：粘贴不完整会提示失败，不会写坏文件。',
    '',
    ...[...steps, logs, uninstall].flatMap(s => [`## ${s.title}`, '', s.note, '', '```bash', s.cmd, '```', '']),
    '## 以后升级',
    '',
    '重新执行第 2、5、6、7 步即可（第 3 步只有依赖版本变了才需要）。登录状态会保留。',
    '',
];
fs.writeFileSync(path.join(ROOT, 'INSTALL.md'), md.join('\n'));
console.log(`INSTALL.md / install/steps.json 已生成：server ${server.b64.length}B, ext1 ${extA.b64.length}B, ext2 ${extB.b64.length}B`);
