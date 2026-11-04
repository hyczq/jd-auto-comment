# jd-auto-comment

> 京东自动评价 + 晒图脚本（浏览器版）

用 Playwright 驱动真实浏览器完成京东「带图评价晒单」，全部走页面 DOM 操作。
登录一次后长期复用 profile，支持 AI 生成评语、自动抓取买家实拍图、图片去重处理。

## 特性

- **纯浏览器操作** —— 不碰下单/登录接口签名，规避接口层风控
- **一次登录长期复用** —— profile 持久化，会话有效期内无需重复登录
- **AI 评语（可选）** —— 一个变量接入任意 OpenAI 兼容接口；未配置则走内置逻辑
- **真实晒图** —— 抓同商品已有买家的实拍图，而非无关素材
- **图片去重** —— 多维度像素扰动 + 感知哈希自检，规避重复图判定
- **多账号** —— `accounts.json` 配置多个 profile 目录
- **预检模式** —— `EVAL_DRY_RUN=true` 只填表不发布，安全验证
- **失败留痕** —— 异常自动截图到 `debug/`

## 工作原理

```
┌─ 登录（人工一次）─────────┐      ┌─ 自动化（每次运行）──────────┐
│ login-setup.js           │      │ index.js                     │
│  ↓ 打开可见浏览器         │      │  ↓ 复用 profile 登录态        │
│  人工扫码/拖滑块          │ ───→ │  ↓ 抓待评价列表               │
│  ↓ 保存 userDataDir      │      │  ↓ 生成评语（AI/买家/模板）    │
└──────────────────────────┘      │  ↓ 抓买家实拍图 + 去重处理     │
                                  │  ↓ 填表 → 晒图 → 发布         │
                                  └──────────────────────────────┘
```

**为什么要人工登录一次？**
京东对数据中心 IP 启用 jcap 设备风控，点「登录」会直接下发滑块图片验证，
账号密码校验根本走不到。因此登录必须由人工完成一次（拖滑块 / 扫个码），
之后脚本复用浏览器 profile 即可长期免登录运行。

## 环境要求

| 项目 | 要求 |
|---|---|
| 运行环境 | 青龙面板（Docker），Debian 变体 |
| Node.js | ≥ 20.3 |
| 浏览器 | chrome-headless-shell 或系统 chromium |
| 显示 | Xvfb 虚拟显示器（有头模式运行）|
| 可选 | sharp（图片去重处理）|
| 可选 | AI 接口（OpenAI 兼容）|

## 文档导航

- [快速开始](#快速开始) —— 6 步跑起来
- [首次使用](#首次使用) —— 从零到跑通的完整流程（含远程桌面登录）
- [AI 评语生成](#ai-评语生成可选)
- [环境变量](#环境变量)
- [常见问题](#常见问题)
- [AGENTS.md](AGENTS.md) —— 给 AI 代理的部署与排障指南


## 快速开始

### 1. 获取脚本

```bash
docker exec qinglong sh -c "cd /ql/data/scripts && git clone <仓库地址> jd-auto-comment"
```

也可以直接把文件复制到青龙的 `scripts/jd-auto-comment/` 目录。

### 2. 安装依赖

在项目目录执行一次即可：

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev"
```

会装好 `playwright`、`fs-extra`、`sharp`（可选）。

> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 避免重复下载浏览器内核，
> 青龙镜像已自带 `chrome-headless-shell`。

### 3. 登录一次（生成 profile）

见 [首次使用](#首次使用) 章节。这一步需要人工操作。

### 4. 配置账号

```bash
cp accounts.example.json accounts.json
```

```json
[
  { "name": "主账号", "userDataDir": "user_data_main" }
]
```

### 5. 预检

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  EVAL_DRY_RUN=true node index.js"
```

### 6. 正式运行

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  EVALNUM=5 node index.js"
```

## 首次使用

> 首次使用必须完成一件事：**生成一个已登录的 `userDataDir`**。
> 这个目录存放京东登录态，之后脚本靠它免登录运行。
>
> **路径约定**：下文以 1Panel 部署为例。
> 宿主机脚本目录 `/opt/1panel/apps/qinglong/qinglong/data/scripts/jd-auto-comment/`
> 对应容器内 `/ql/data/scripts/jd-auto-comment/`。
> 其他部署方式请按实际路径替换。

**为什么不能自动登录？**
京东对你服务器的机房 IP 启用了 jcap 设备风控，点「登录」立刻弹滑块，
密码校验根本走不到。所以登录这一步必须人工做一次（拖滑块/扫个码）。

---

### 第 0 步：确认前置条件

SSH 登录到你的服务器，执行：

```bash
# 1. 青龙容器在跑吗
docker ps | grep qinglong

# 2. 容器里有 node 和浏览器吗
docker exec qinglong sh -c "node -v && ls /ql/data/dep_cache/node/headless-shell/bin/"
```

正常应该看到 Node 版本（≥20）和 `chrome-headless-shell`。

---

### 第 1 步：把脚本放到青龙

青龙的 `/ql/data/scripts/` 就是宿主机数据目录下的 `scripts/`，两种方式任选：

方式一：容器内克隆

```bash
docker exec qinglong sh -c "cd /ql/data/scripts && git clone <仓库地址> jd-auto-comment"
```

方式二：在宿主机直接放文件

```bash
cd /opt/1panel/apps/qinglong/qinglong/data/scripts/jd-auto-comment
ls
```

确认目录内有：`index.js` `review.js` `imagefetch.js` `imageproc.js`
`aitext.js` `browser.js` `login.js` `login-setup.js` `utils.js`

---

### 第 2 步：启动远程桌面

这一步通过 VNC 提供一个**可在浏览器中操作的 Linux 桌面**，用于完成京东登录。

```bash
cd /opt/1panel/apps/qinglong/qinglong/data/scripts/jd-auto-comment
sh start-desktop.sh
```

脚本跑完会打印类似这样的信息，**记下 VNC 密码**：

```
==================================================
  桌面已就绪
==================================================
  容器 IP     : 172.18.0.7
  VNC 密码    : Zx7kQ2mN9p

  在你自己的电脑上执行（保持窗口不关）：
    ssh -L 6080:127.0.0.1:6080 root@<服务器IP>

  然后浏览器打开：
    http://127.0.0.1:6080/vnc.html
==================================================
```

> **不想用 start-desktop.sh？** 手动执行等价命令：
> ```bash
> docker exec -d qinglong sh -c "Xvfb :99 -screen 0 1440x900x24 -ac"
> docker exec -d qinglong sh -c "x11vnc -display :99 -rfbport 5900 -forever -shared -nopw -quiet"
> docker exec -d qinglong sh -c "websockify --web /usr/share/novnc 6080 127.0.0.1:5900"
> nohup socat TCP-LISTEN:6080,fork,reuseaddr TCP:172.18.0.7:6080 &
> ```

---

### 第 3 步：建立 SSH 隧道（在你自己的电脑上）

打开 **你自己电脑** 的终端（Windows 用 PowerShell，Mac/Linux 用 Terminal）：

```bash
ssh -L 6080:127.0.0.1:6080 root@你的服务器IP
```

输入 root 密码后，**这个窗口要一直开着**，别关。

> 这条命令的作用：把服务器的 6080 端口加密映射到你电脑的 6080，
> 这样不用动防火墙、不用开放任何公网端口。

---

### 第 4 步：在浏览器中打开桌面

打开你电脑上的浏览器，访问：

```
http://127.0.0.1:6080/vnc.html
```

1. 点页面上的 **Connect** 按钮
2. 输入第 2 步记下的 **VNC 密码**
3. 你会看到一个 1440x900 的桌面

---

### 第 5 步：启动登录程序

回到服务器的 SSH 窗口（另开一个），执行：

```bash
docker exec -d qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  node login-setup.js user_data_main"
```

> `user_data_main` 是 profile 目录名，你可以改成别的（比如 `user_data_小号`）。

执行后浏览器窗口里会自动打开京东评价中心页面。

---

### 第 6 步：在桌面里登录京东

看着 VNC 桌面里的浏览器：

1. 如果显示登录页，点「**扫码登录**」，用**手机京东 App** 扫码并在手机上确认
   （也可以选短信验证码或账号密码，但扫码最省事）
2. **如果弹出滑块**，用鼠标拖动那个滑块，把箭头拖到缺口
3. 登录成功后页面会跳到「评价中心」

> 这一步是唯一需要你亲手做的。滑块必须人拖，代码拖会被判风险。

---

### 第 7 步：等待自动确认

登录成功后，`login-setup.js` 会自动检测到，服务器上会打印：

```
──────────────────────────────────────────────
[Login] ✅ 登录成功！
[Login]    账号: 你的昵称
[Login]    待评价商品: 30 个
[Login]    profile 已保存: /ql/data/scripts/jd-auto-comment/user_data_main
──────────────────────────────────────────────

[System] 现在可以运行主脚本了：
[System]   EVAL_DRY_RUN=true node index.js
```

看到这个就说明 `userDataDir` 生成成功了。

---

### 第 8 步：配置 accounts.json

```bash
cd /opt/1panel/apps/qinglong/qinglong/data/scripts/jd-auto-comment
cp accounts.example.json accounts.json
cat accounts.json
```

默认内容（如果第 5 步用了默认目录，无需修改）：

```json
[
  { "name": "主账号", "userDataDir": "user_data_main" }
]
```

**多账号**：重复第 2~7 步（第 5 步换目录名），然后写成：

```json
[
  { "name": "主账号", "userDataDir": "user_data_main" },
  { "name": "小号",   "userDataDir": "user_data_小号" }
]
```

---

### 第 9 步：预检（不发布）

先跑一次预检，确认一切正常：

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  EVAL_DRY_RUN=true node index.js"
```

预期输出：

```
[System] 共 1 个账号
[System] 每账号最多评价 5 个商品（EVALNUM 可调）
[System] DRY RUN 模式：只填表不发布
[Login] 已登录（复用 profile 会话）
[Read] 待评价商品 30 个
[Review] [1/5] 第 1 个待评价商品
[Review] 评语来源: 买家5星好评（70 字）
[Image] 已上传 2 张买家实拍图
[Review] 🔍 预检通过（已填表+配图 2 张，未发布）
```

> 依赖须先在本项目目录执行 `npm install --omit=dev` 装好（见「快速开始」第 2 步）。
> 未装 `sharp` 也能运行，只是跳过图片去重处理。

---

### 第 10 步：正式运行

确认预检没问题后，去掉 `EVAL_DRY_RUN` 即可真实发布：

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  EVALNUM=5 node index.js"
```

---

### 第 11 步：设置青龙定时任务

青龙面板 → 定时任务 → 新建：

| 字段 | 填什么 |
|---|---|
| 名称 | 京东自动评价 |
| 命令 | `task jd-auto-comment/index.js` |
| 定时规则 | `0 10 * * *`（每天 10 点） |

然后在青龙「环境变量」里加：

| 变量名 | 值 |
|---|---|
| `EVAL_AI` | 需要 AI 评语时填（格式见「AI 评语生成」）|

> **不需要配 `NODE_PATH`** —— 依赖装在项目内 `node_modules/`，Node 会自己向上查找。

> ⚠️ **容器重启后 Xvfb 会消失**，需要重新执行第 2 步。
> 建议把 `start-desktop.sh` 里的 Xvfb 启动命令加进青龙的「启动前脚本」。

---

### 第 12 步：关闭远程桌面（可选，建议）

登录完成、profile 已保存后，VNC 就没用了。为安全起见关掉：

```bash
docker exec qinglong sh -c "pkill -f x11vnc; pkill -f websockify"
pkill -f "socat.*6080"
```

Xvfb 要保留（脚本运行时需要），只关 VNC 和端口转发即可。

---

### 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `未找到浏览器` | headless-shell 缺失 | 检查 `/ql/data/dep_cache/node/headless-shell/bin/` |
| 浏览器打开 `127.0.0.1:6080` 白屏 | SSH 隧道没建/断了 | 重开第 3 步的 ssh 命令 |
| VNC 连上但黑屏 | Xvfb 没起来 | 重跑第 2 步 |
| 登录后一直不显示成功 | 页面未跳转到评价中心 | 在桌面上手动点一下「评价中心」 |
| `[Login] profile 会话已失效` | 登录态过期 | 重跑第 2~7 步 |
| 图片没上传 | 该商品无带图评价 | 正常，会只发文字 |
| 想重来 | profile 坏了 | `rm -rf user_data_main` 后重做第 5 步 |

---

### 一句话流程总结

```
启动桌面 → SSH隧道 → 浏览器开VNC → 跑login-setup → 手动登录 → 自动保存 → 跑index.js
```

---

## 登录方式

只支持**复用已登录的 `userDataDir` profile**，不提供账号密码登录。
原因见上文「为什么要人工登录一次」。

## 文件

| 文件 | 说明 |
|---|---|
| `login-setup.js` | **首次使用**：打开可见浏览器供人工登录，自动保存 profile |
| `start-desktop.sh` | **首次使用**：一键启动 Xvfb + x11vnc + noVNC + 端口转发 |
| `index.js` | 主流程：账号循环、评语生成、晒图、汇总、通知 |
| `review.js` | 评价表单操作 + 页面选择器（`SEL` 常量） |
| `aitext.js` | AI 评语生成（OpenAI 兼容接口） |
| `imagefetch.js` | 抓同商品买家实拍图 + 5 星好评文字 |
| `imageproc.js` | 图片去重处理（多维扰动 + 哈希自检） |
| `login.js` | 账号配置读取 + 登录态检查 |
| `browser.js` | Playwright 持久化 profile 启动器、Xvfb 自动准备 |
| `ensure-display.sh` | 手动确保 Xvfb 运行（调试用，通常无需执行） |
| `utils.js` | 常量、日志、工具 |

## 晒图策略

解决「晒单与商品不符 / 含截图」被驳回：

1. 从 `club.jd.com/comment/productPageComments.action` 拉该商品评价
   （**必须用 `score=0`**，传 `score=5` 京东返回空数组）
2. 只取 5 星、有图的，正文过滤差评词/联系方式/链接
3. `s128x96_jfs` → `s800x800_jfs` 拿清晰大图
4. sharp 重新缩放+重编码，避免「重复图」判定
5. 图片数取 `Math.max(2, 官方要求图数)`

评语：`EVAL_WORD` 自定义 > 该商品 5 星好评随机挑 > 内置模板。

### 去重处理

京东用感知哈希（pHash/dHash）比对重复图，**单纯缩放+重编码无效**——
文件字节变了，像素结构几乎不变，哈希仍然相同。

`imageproc.js` 做多维度像素扰动，每轮叠加：

| 手段 | 作用 |
|---|---|
| 边缘裁切 1.5%~5% | 改变构图边界 |
| 概率性镜像翻转（0.65） | 对哈希影响最大 |
| 轻微旋转 ±1.2°+白边 | 改变像素网格对齐 |
| 亮度/饱和/色相微调 | 打散色彩分布 |
| 锐化 或 轻微模糊 | 改变高频细节 |
| RGBA 噪点叠加（4%~9% 透明度） | 打散直方图 |
| 随机 JPEG 质量 80~92 | 改变编码指纹 |

关键在于**自检闭环**：处理完立即用 dHash 比对原图，汉明距离 < 12（可配
`EVAL_DEDUP_HAMMING`）就自动加强扰动重试，最多 4 轮。达标才用新图，
不达标退回原图（宁可用原图也不传坏图）。

哈希差异参考：

```
第1轮 差异=31,33 达标=true
第2轮 差异=32,31 达标=true
第3轮 差异=34,36 达标=true
```

汉明距离普遍 22~36（64 位哈希），远超一般重复判定阈值（通常 5~10）。

### AI 评语生成（可选）

配置一个环境变量即可启用，支持任意 **OpenAI 兼容接口**
（OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等）。

#### 配置方式

```bash
EVAL_AI=<接口地址>;<API密钥>;<模型名>
```

三段用**英文分号** `;` 分隔，缺任意一段则视为未配置、自动退回内置逻辑。

示例：

```bash
EVAL_AI=https://api.deepseek.com/v1/chat/completions;sk-xxxxxxxx;deepseek-flash
```

> 青龙面板「环境变量」里直接填整串即可，不用拆成多个变量。

#### 常见服务填写示例

| 服务 | 接口地址 | 模型名 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-flash` / `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| Moonshot | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus` |
| 本地 Ollama | `http://127.0.0.1:11434/v1/chat/completions` | `qwen2.5` |

> 本地 Ollama 不校验密钥，填任意非空值即可，如 `ollama`。

#### 优先级链

```
EVAL_WORD（自定义评语，最高）
  └→ AI 生成（配置了 EVAL_AI 才启用）
      └→ 该商品买家 5 星好评
          └→ 内置模板（兜底）
```

任一环节失败自动降级，不影响主流程。

#### 提示词要点

`aitext.js` 内置的 system prompt 已约束这些，避免生成不合规内容：

- 第一人称口语化，不要广告腔
- 只输出正文，无前缀、引号、Markdown
- 不提价格数字、订单号、物流单号、客服姓名
- 不出现「京东/商家/卖家」等平台称呼
- 不用「总的来说/综上所述」等书面语
- 不编造商品不具备的功能
- 30~120 字，单段不换行，无 emoji

生成后还会二次清洗：去前缀、去包裹引号、压成单段、滤 emoji、截断 480 字。

同一批次内会把**已用过的评语**作为「避免雷同」参考传给模型。

#### 行为说明

| 场景 | 结果 |
|---|---|
| 未配置 `EVAL_AI` | 走「买家5星好评」→「内置模板」 |
| 配置正确 | 日志显示 `评语来源: AI(模型名)` |
| 格式错误（缺段/非 http） | 打印提示并忽略，退回内置逻辑 |
| 接口不可达 | 打印 `AI 生成失败: ...`，降级不中断 |
| 模型输出含前缀/引号 | 自动清洗为干净正文 |

请求超时固定 30 秒，无需配置。


## 环境变量

**没有必填项** —— 全部有默认值或自动处理，装好依赖即可直接运行。

### 常用可选配置

| 变量 | 说明 | 默认 |
|---|---|---|
| `EVAL_AI` | AI 评语配置，格式 `地址;密钥;模型` | 空（不启用 AI） |
| `EVALNUM` | 每账号最多评价几个商品（正整数） | 5 |
| `EVAL_DRY_RUN` | `true` = 只填表不发布 | 关闭 |
| `EVAL_WORD` | 自定义评语，`@` 分隔（优先级最高）| 空 |

### 进阶可选配置

| 变量 | 说明 | 默认 |
|---|---|---|
| `EVAL_WORD_COUNT` | 买家评语最少字数 | 10 |
| `EVAL_NO_IMAGE` | `true` = 不晒图纯文字 | 关闭 |
| `EVAL_DEDUP_HAMMING` | 图片去重哈希差异阈值 | 12 |
| `EVAL_BROWSER_PATH` | 指定浏览器可执行文件 | 自动查找 |
| `AUTOCOMMENT_ACCOUNTS` | accounts.json 路径 | `./accounts.json` |
| `AUTOCOMMENT_NOTIFY` | `false` 关闭通知 | 开启 |

### 最小配置示例

只想跑起来，一个变量都不用加：

```bash
node index.js
```

想用 AI 生成评语：

```bash
EVAL_AI=https://api.deepseek.com/v1/chat/completions;sk-xxxx;deepseek-chat
```


## 依赖

### 必需依赖

| 依赖 | 说明 |
|---|---|
| **playwright** | 浏览器自动化核心 |
| **fs-extra** | 文件操作（配置读取、临时图片） |
| **chrome-headless-shell** | 浏览器内核，青龙 chromium 镜像通常已内置 |
| **Xvfb** | 虚拟显示器，脚本以有头模式运行 |

### 可选依赖

| 依赖 | 说明 |
|---|---|
| **sharp** | 图片去重处理（裁剪/旋转/噪点/重编码）。不装也能跑，只是跳过图片处理 |

### 安装方式（二选一）

#### 方式 A：青龙「依赖管理」安装（推荐，最省事）

青龙面板 → **依赖管理** → **NodeJS** → 新建，依次添加：

```
playwright
fs-extra
sharp
```

或一次性用命令行批量安装：

```bash
docker exec qinglong sh -c "cd /ql && npm install playwright fs-extra sharp --prefix /ql/data/dep_cache/node/global/5"
```

青龙的全局 node_modules 已在容器 `NODE_PATH` 里，装完即可直接运行，**无需额外配置**。

#### 方式 B：项目内安装

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev"
```

Node 会从脚本目录向上查找 `node_modules/`，同样**无需配置 NODE_PATH**。

> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 避免重复下载浏览器内核，
> 青龙镜像里已有 `chrome-headless-shell`。

### 浏览器内核

如果容器内没有 `chrome-headless-shell`，需额外安装：

```bash
docker exec qinglong sh -c "cd /ql/data/dep_cache/node && \
  npm install playwright --prefix /ql/data/dep_cache/node/global/5 && \
  /ql/data/dep_cache/node/global/5/node_modules/.bin/playwright install chromium"
```

或手动放置到 `/ql/data/dep_cache/node/headless-shell/bin/`。

### 首次登录所需（仅一次性）

如果要用 `start-desktop.sh` 走 VNC 手动登录，需要：

| 组件 | 用途 |
|---|---|
| `x11vnc` | VNC 服务 |
| `noVNC` + `websockify` | 浏览器访问 VNC |
| `socat` | 宿主机端口转发 |

Debian 容器内安装：

```bash
docker exec qinglong sh -c "DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc novnc websockify"
```

登录完成、profile 已保存后，这几个组件可以不用了。

## 注意事项

- **脚本以有头模式运行** —— 使用 `:99` 虚拟显示器，启动时自动检测并按需拉起 Xvfb
- **会话会过期** —— 失效时脚本会打印重新登录提示，重跑 `login-setup.js` 即可
- **京东页面可能改版** —— 选择器失效时先跑 `EVAL_DRY_RUN` 看 `debug/` 截图
- **建议控制频率** —— 每次 5 个商品左右，脚本已内置随机间隔
- **不要提交敏感文件** —— `accounts.json`、`user_data_*/`、`debug/` 已在 `.gitignore` 中

## 免责声明

本项目仅供**学习与技术研究**使用，用于了解浏览器自动化、图像处理与 AI 文本生成的实现方式。

使用前请知悉：

1. **请遵守京东的用户协议与相关法律法规**，自动化操作可能违反平台规则
2. **账号风险自负** —— 使用自动化工具可能导致账号被限制、降权或封禁
3. **评价内容真实性自负** —— 请勿发布与实际商品不符的内容
4. **图片版权** —— 脚本抓取的是其他买家的实拍图，复用他人图片存在版权与真实性争议，
   建议仅用于技术研究，实际使用请替换为你自己拍摄的照片
5. 作者不对因使用本项目产生的任何后果承担责任

**如果你只是想省事地完成评价，建议直接手动操作**——本项目的价值在于技术学习。

## 许可

MIT License

## 致谢

架构参考 [bingScript](https://github.com/zgcwkj/bingScript) 的浏览器自动化思路。
