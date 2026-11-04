# AGENTS.md — jd-auto-comment 使用指南（面向 AI 代理）

> 本文档供 AI 代理阅读，目标是让代理**无需追问即可正确部署、排障、改代码**。
> 人类用户请读 [README.md](README.md)。

---

## 0. 项目本质

用 Playwright 驱动**真实浏览器**完成京东「带图评价晒单」。

**关键约束：没有 API 层捷径。**
不要尝试用 `pt_key` / 签名接口方案——京东对数据中心 IP 启用 jcap 设备风控，
接口层的登录会直接收到滑块验证。本项目绕开这条路径，全部走页面 DOM 操作。

## 1. 目录结构

```
jd-auto-comment/
├── index.js          主流程：账号循环 → 登录检查 → 评价 → 汇总
├── review.js         评价表单操作（含全部页面选择器 SEL 常量）
├── imagefetch.js     抓同商品买家实拍图 + 5星好评文字
├── imageproc.js      图片去重处理（像素扰动 + dHash 自检）
├── aitext.js         AI 评语生成（OpenAI 兼容接口）
├── login.js          accounts.json 读取 + 登录态检查
├── browser.js        Playwright 持久化 profile 启动器
├── login-setup.js    首次使用：人工登录并保存 profile
├── utils.js          常量（LogTag / JD_URLS）、sleep/rand/pick
├── start-desktop.sh  一键启动 Xvfb + x11vnc + noVNC + 端口转发
├── accounts.json     账号配置（git 忽略）
└── user_data_*/      已登录 profile（git 忽略）
```

## 2. 运行环境事实

| 项 | 值 |
|---|---|
| 容器 | `qinglong`（Debian 变体）|
| Node | v20.20.x（有内置 fetch）|
| 浏览器 | `/ql/data/dep_cache/node/headless-shell/bin/chrome-headless-shell` |
| playwright | `/ql/data/dep_cache/node/global/5/node_modules/playwright` |
| 虚拟显示器 | Xvfb `:99`，1440x900x24 |
| 脚本目录 | `/ql/data/scripts/jd-auto-comment/`（容器内）|
| 宿主机等价路径 | `/opt/1panel/apps/qinglong/qinglong/data/scripts/jd-auto-comment/` |

**标准启动命令**：

```bash
docker exec qinglong sh -c "cd /ql/data/scripts/jd-auto-comment && node index.js"
```

所有环境变量均有默认值，装好依赖即可直接运行。

**运行时行为**：
- 依赖解析：装在项目内 `node_modules/`，Node 从脚本目录向上查找
- 显示器：`browser.js` 的 `ensureDisplay()` 默认使用 `:99`，
  检测 `/tmp/.X11-unix/X99` socket，缺失时自动 `spawn Xvfb`
- 评价数量：默认 5

## 3. 环境变量全表

> 全部可选，均有默认值。
| 变量 | 默认 | 说明 |
|---|---|---|
| `EVALNUM` | 5 | 每账号最多评价几个商品，必须正整数，非法值回退默认 |
| `EVAL_DRY_RUN` | 关闭 | `true` = 只填表不发布 |
| `EVAL_WORD` | 空 | 自定义评语，多条用 `@` 分隔；设了则优先级最高 |
| `EVAL_WORD_COUNT` | 10 | 从买家评价挑评语时的最少字数 |
| `EVAL_NO_IMAGE` | 关闭 | `true` = 不晒图纯文字 |
| `EVAL_AI` | 空 | AI 配置，格式 `地址;密钥;模型`（分号分隔）。空=不启用 |
| `EVAL_DEDUP_HAMMING` | 12 | 图片去重哈希差异阈值 |
| `EVAL_BROWSER_PATH` | 自动 | 指定浏览器可执行文件 |
| `AUTOCOMMENT_ACCOUNTS` | `./accounts.json` | 账号配置路径 |
| `AUTOCOMMENT_NOTIFY` | 开启 | `false` 关闭通知 |

## 4. 评语生成优先级链

改评语逻辑时**必须保持这个顺序**：

```
EVAL_WORD（自定义）
  └→ AI 生成（配置了 EVAL_AI 才启用）
      └→ 该商品买家 5 星好评
          └→ 内置模板（兜底）
```

实现位置：`review.js` 的 `generateText(page)`。任意环节失败必须降级，不能抛异常中断。

## 5. 京东页面选择器（改版时改这里）

全部集中在 `review.js` 的 `SEL` 常量：

| 常量 | 选择器 | 用途 |
|---|---|---|
| `CENTER_RATE_BTN` | `.rate-btn` | 待评价列表的「去评价」按钮 |
| `TEXTAREA` | `textarea.rate-comment-content-textarea` | 评语输入框（上限 500 字）|
| `FILE_INPUT` | `input.uploadAddInput` | 图片上传 |
| `SUBMIT` | `.rate-publish-submit-button` | 发布按钮 |

页面地址（`utils.js` 的 `JD_URLS`）：

- 评价中心：`https://comment.m.jd.com/pc-static/center`
- 发布页：`https://comment.m.jd.com/pc-static/publish?orderId=..&skuId=..&commentType=1`

**关键行为**：
- 「去评价」在**新标签页**打开，必须用 `ctx.waitForEvent('page')` 接住
- 页面是 React SPA，填字必须用 `type()`（触发 onInput），`fill()` 可能不生效
- 发布成功标志：页面出现「评价成功，感谢您!」

## 6. 图片获取接口

```
https://club.jd.com/comment/productPageComments.action
  ?productId=<skuId>&score=0&sortType=5&page=0&pageSize=20
```

**必须传 `score=0`**。传 `score=5` 时接口返回 `{"comments":[],"csv":"NOTHING"}`——
看似成功实为空数组，会导致「无可用图片」误判。

返回的 `comments[].images[].imgUrl` 是买家实拍图，
`s128x96_jfs` 换成 `s800x800_jfs` 可得清晰大图。

## 7. 常见故障与定位

| 现象 | 原因 | 处理 |
|---|---|---|
| `AIText is not defined` | require 语句缺失 | 检查 `review.js` 顶部 import |
| `profile 会话已失效` | 登录态过期 | 重跑 `login-setup.js`（需 VNC）|
| `未找到可用的浏览器` | 路径不对 | 设 `EVAL_BROWSER_PATH` 或装 headless-shell |
| `评价表单未出现` | 页面改版/加载慢 | 看 `debug/form_not_ready_*.png` |
| `等待发布结果超时` | 发布被限制 | 看 `debug/submit_unknown_*.png` |
| 图片未上传 | 该商品无带图评价 | 正常行为，会只发文字 |
| sharp 报 `MODULE_NOT_FOUND` | 未装依赖 | 青龙依赖管理装 `sharp`，或项目内 `npm install` |
| `EVAL_AI 格式错误` | 变量没按 `地址;密钥;模型` 填 | 检查三段是否齐全、地址是否 http(s) 开头 |
| 脚本卡住不退出 | 浏览器进程残留 | `pkill -f chromium` |

## 8. 首次登录流程（人工介入点）

AI 代理**无法独立完成登录**，必须引导用户操作：

1. 跑 `sh start-desktop.sh` 启动虚拟桌面
2. 用户在自己电脑建 SSH 隧道：`ssh -L 6080:127.0.0.1:6080 root@<服务器IP>`
3. 用户浏览器开 `http://127.0.0.1:6080/vnc.html` 输入 VNC 密码
4. 跑 `login-setup.js`，浏览器打开京东页面
5. **用户手动扫码 / 拖滑块**
6. `login-setup.js` 自动检测到登录并保存 profile
7. 之后 `index.js` 可长期复用

## 8.5 依赖安装

**必需**（青龙「依赖管理 → NodeJS」添加，或项目内 npm install）：

```
playwright
fs-extra
sharp        # 可选，缺省则跳过图片去重
```

青龙依赖管理装完在 `/ql/data/dep_cache/node/global/5/node_modules`，
已在容器 `NODE_PATH` 内，可直接用。

浏览器内核：`chrome-headless-shell`（青龙 chromium 镜像通常已内置）。
虚拟显示器：`Xvfb`。

首次登录额外需要：`x11vnc`、`novnc`、`websockify`（apt 安装）。

## 9. 修改代码时的注意事项

- **不要引入 API 签名方案** —— 已被证明在此环境不可行
- **不要在代码里写死服务器专属路径** —— 用环境变量
- **不要在注释里写日期和"实测"字样** —— 这是公开发布的项目
- **评语链必须保留兜底** —— AI/买家评价失败要能降级到内置模板
- **图片去重必须保留自检** —— 哈希差异不达标要退回原图而非上传坏图
- **所有新增选择器放进 `SEL`** —— 便于京东改版时统一维护

## 10. 验证改动是否有效

```bash
# 1. 语法检查
for f in *.js; do node --check "$f" || echo "FAIL $f"; done

# 2. 预检（不发布，最安全的验证方式）
EVAL_DRY_RUN=true EVALNUM=1 node index.js
```

**永远先跑 `EVAL_DRY_RUN=true`**，确认填表和晒图都正常再考虑实发。

## 11. 相关文档

- [README.md](README.md) — 人类用户文档，含 12 步首次使用教程
- 项目无外部依赖文档，所有信息以本文和 README 为准
