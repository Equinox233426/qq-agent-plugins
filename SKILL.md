---
name: qq-agent-deploy
description: 把 QQ Agent 部署到一台本地 Windows 机器并跑通(取代码 → 装依赖 → 装 QQ 协议端 → 扫码登录 → 配模型与白名单 → 验证)。适用于组员拿到公开快照后第一次本地部署、或排障「装完了但不回话」。
---

# QQ Agent 本地部署

一个跑在自己电脑上的 QQ 群聊机器人:Electron 桌面壳 + OneBot v11 协议端 + 任意 OpenAI 兼容模型。

- 仓库(公开快照):`https://github.com/Equinox233426/qq-agent-plugins`
- 上游/原项目:`https://github.com/Kondius/qq-agent`
- 仓库**不含**:`runtime/`(便携 QQ)、`snowluma/`(第三方协议端)、`data/sessions/`(真实聊天存档)、任何 Key 与 QQ 号

## 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64(项目只支持 Windows) |
| Node.js | **≥ 20**(`package.json` engines);低于 20 会白屏或直接起不来 |
| 磁盘 | 至少 **4 GB** 空闲(依赖 ~400 MB + 便携 QQ ~1.5 GB + 运行数据) |
| 网络 | 能访问 GitHub 与 `npm` 源;国内建议先配镜像/代理 |

## 部署步骤

### 1. 取代码

```powershell
git clone https://github.com/Equinox233426/qq-agent-plugins.git qq-agent
cd qq-agent
```

连不上 GitHub 就直接下载 ZIP 解压,GitHub 页面的 `Code → Download ZIP` 走的域名与网页不同,常常反而能下。

### 2. 装依赖

```powershell
npm install
```

慢就换镜像:`npm config set registry https://registry.npmmirror.com`。

若仓库 Releases 里提供了 `node_modules.zip`,也可以解压到项目根目录顶替 `npm install`——但 **不要**把 `node_modules` 提交回仓库。

### 3. 装协议端与便携 QQ

```powershell
npm run setup        # 下载 SnowLuma + 固定版本便携 QQ(幂等,可重复跑)
npm run setup:check  # 只检查是否就绪,不下载
```

`npm run setup` 失败时手动兜底:

1. **SnowLuma**(第三方,自带 EULA,不随仓库分发):从官方渠道取,解压到项目根目录,**目录名必须是 `snowluma`**
2. **便携 QQ**(可选):机器上装过 QQ 的话,先**完全退出 QQ(含托盘)**,再跑 `npm run setup`,脚本会从注册表找到已装的 QQ 复制一份到 `runtime/qq-portable/`

> QQ 9.9.x 用腾讯自研 HummerSetup,**不支持静默安装**,脚本不会盲试。已有更高版本时也装不回指定版本——所以走便携分发。

### 4. 启动并登录

```powershell
npm start            # 桌面端(Electron)
# 或双击 启动QQ机器人.bat
npm run server       # headless:浏览器打开 http://127.0.0.1:3210
```

打开后在 **SnowLuma 页签**点「启动 QQ」,用要当机器人的那个 QQ 扫码登录。扫码成功后页签会显示连接状态,没显示就是没连上,后面一定不回话。

### 5. 配置

设置页顶部的**体检卡**会直接列出缺什么,照着补:

1. **模型**:填 Base URL + API Key → 点「获取列表」→ 搜索并选模型 → 点「测试」确认有延迟
2. **白名单**:从 QQ 里直接勾选允许它说话的群。**白名单为空 = 谁都不回**,这一步最容易漏
3. **人设**:默认人设够用;要改就在设置页改,别直接手改 `data/config.json`(会被控制台覆盖)
4. **技能/插件**:`skills/` 与 `plugins/` 下的都可在控制台开关,默认不开的按需开

## 关键事实

- **所有配置都在 `data/config.json`**,由控制台写入。仓库里那份是**脱敏模板**:`apiKey` 一律为空、QQ 号与群号统一是 `100000000`。**不要把它当运行时配置**——首次启动让程序自己生成,或把占位符改回真实值。
- 模型 Key 只存本地,不会外传;但 `data/` 一旦提交到仓库就等于泄露。
- 默认端口:headless 是 `3210`,桌面端端口被占会自动让位。
- 每次处理消息都新开会话(无状态架构),token 成本恒定,不随聊天量膨胀。

## 排障

| 现象 | 先查 |
| --- | --- |
| 白屏/闪退 | Node 版本 < 20;`node -v` 确认 |
| 扫码后不回话 | SnowLuma 页签是否显示已连接;白名单是否勾了当前群;群里是否 @ 了它 |
| 回了但没反应到群里 | 发送白名单/限频;工具绑定会话,模型发不到别的群 |
| 模型 401/超时 | Base URL 末尾别多 `/v1`;用「测试」按钮看具体报错 |
| `npm run setup` 下载失败 | 手动放 `snowluma/`;或 `npm run pack:qq` 从本机 QQ 打包便携包 |
| 端口占用 | 控制台改端口,或先关掉上一次的进程 |
| 装完体积不对 | `runtime/` 约 1.5 GB 属正常,不是漏了文件 |

## 验证清单(交付前逐条打勾)

- [ ] `node -v` ≥ 20
- [ ] `npm run setup:check` 无红项
- [ ] 控制台体检卡无红色提示
- [ ] SnowLuma 显示已连接,QQ 头像正常
- [ ] 在测试群 @ 机器人一次,5 秒内有回复
- [ ] `data/config.json` 里没有别人机器的 Key,也没有真实群号被误提交

## 安全边界

- **分享/提 issue 前**先跑 `node scripts/sanitize-release.mjs --scan`,它会扫 Key;`--dry-run` 可看会清什么。
- 永远不要 `git add data/`——里面是真实聊天记录、群友记忆和明文 Key。项目自带的 `.gitignore` 已经排除,别手动 `-f` 绕过。
- QQ 本体是腾讯专有软件,便携包是"复制"而非修改,**再分发前自己确认许可条款**。
- 机器人以主人的 QQ 身份发言,出事影响的是你自己的号——先在测试群跑一周再进主群。

## 重置

```powershell
# 只重置配置与记忆
Remove-Item data -Recurse -Force

# 连依赖一起重来
Remove-Item node_modules, runtime -Recurse -Force
npm install; npm run setup
```
