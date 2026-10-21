# 网易云播放器 · 服务端插件

前端扩展（仓库根目录）负责界面和播放，这个服务端插件负责替它去问网易云：搜歌、歌单、播放地址、扫码登录。
两部分都要装，只装前端的话，打开播放器会提示「服务端插件没有加载（404）」。

服务端插件酒馆不能在网页里安装，要在运行酒馆的电脑或服务器上手动操作，一共三步。

## 1. 把插件放进 `plugins/`

最终要得到这样的目录（`SillyTavern` 是酒馆的安装目录）：

```
SillyTavern/plugins/netease-player/
  package.json  index.mjs  lib.mjs  selftest.mjs
```

文件从哪来，任选一种：

- **已经用「安装扩展」装好了前端**：仓库整个被下载到了扩展目录里，从那里复制。
  ```bash
  cd SillyTavern
  # 安装时点的是「只给我安装」或「安装」（default-user 换成你的酒馆用户名）
  cp -r data/default-user/extensions/Golky-body-/server/netease-player plugins/
  # 安装时点的是「给所有人安装」
  cp -r public/scripts/extensions/third-party/Golky-body-/server/netease-player plugins/
  ```
  （`Golky-body-` 是仓库名，仓库改过名就换成新名字。）
- **直接从 GitHub 下载**：
  ```bash
  git clone --depth 1 https://github.com/Xiaxiii/Golky-body- /tmp/nep-src
  cp -r /tmp/nep-src/server/netease-player SillyTavern/plugins/
  ```
  没有 git 的话，在 GitHub 页面点 Code → Download ZIP，解压后把 `server/netease-player` 文件夹复制到 `SillyTavern/plugins/` 里。

然后安装依赖（网易云接口包，约 1～3 分钟）：

```bash
cd SillyTavern/plugins/netease-player
npm install --omit=dev
# 国内服务器慢或失败时用镜像：
# npm install --omit=dev --registry=https://registry.npmmirror.com
```

Windows：在资源管理器里复制文件夹，然后在 `plugins\netease-player` 文件夹的地址栏输入 `cmd` 回车，执行同样的 `npm install --omit=dev`。

## 2. 打开服务端插件开关

编辑 `SillyTavern/config.yaml`，找到这一行改成 `true`（默认是 `false`）：

```yaml
enableServerPlugins: true
```

## 3. 重启酒馆

用什么方式启动的就怎么重启（关掉 `Start.bat` / `start.sh` 窗口再打开，或 `pm2 restart <进程名>`，或重启 Docker 容器）。
启动日志里出现这一行就是装好了：

```
[netease-player] loaded（接口包会在第一次使用时才载入）
```

然后浏览器里刷新酒馆页面。

### 可选：自检

确认服务器能连上网易云：

```bash
cd SillyTavern
node plugins/netease-player/selftest.mjs
```

看到 `SELFTEST OK` 就没问题。提示 460 是网易云拦了服务器自己的 IP；实际使用时插件会带上手机/电脑的 IP，一般不受影响，可以先去页面上试试能不能搜歌。

## Docker

`plugins/` 和 `config.yaml` 要在挂载出来的目录里改：官方 `docker-compose.yml` 把它们挂在 `./plugins` 和 `./config/config.yaml`。
`npm install` 可以在宿主机上做（宿主机要有 Node），也可以进容器做：`docker exec -it sillytavern sh -c "cd plugins/netease-player && npm install --omit=dev"`。

## 升级

用新版本的 `package.json`、`index.mjs`、`lib.mjs`、`selftest.mjs` 覆盖旧文件，重启酒馆。
`package.json` 里的依赖版本变了才需要重新 `npm install`。登录状态保存在 `data/` 里，覆盖文件不会丢。

## 卸载

删除 `SillyTavern/plugins/netease-player` 整个文件夹（网易云登录信息也一起删掉），重启酒馆。
前端扩展在酒馆的「扩展」→「管理扩展」里删除。

## 登录信息存在哪

扫码登录后，网易云的登录 cookie 只保存在服务器上的
`plugins/netease-player/data/cookie-<酒馆用户名>.json`（目录权限 700、文件权限 600），
不会发给浏览器，也不在这个仓库里。**把自己装好的插件文件夹分享给别人时，不要带上 `data/` 和 `node_modules/`。**

酒馆开了多用户时，每个酒馆用户各自扫码、各自保存登录状态。
