/**
 * login-setup.js —— 首次使用：生成已登录的 userDataDir
 *
 * 作用：在虚拟显示器上打开一个真实可交互的浏览器，停在京东登录页，
 *       由人工完成登录（拖滑块 / 输短信验证码），登录成功后自动固化 profile。
 *
 * 用法（在青龙容器内）：
 *   node login-setup.js [profile目录名]
 *
 * 默认 profile 目录：user_data_main
 *
 * 登录成功后，该目录即可被 index.js 复用，之后无需再次登录（除非会话过期）。
 */

const fs = require('fs-extra')
const path = require('path')
const { chromium } = require('playwright')
const { LogTag, sleep } = require('./utils')
const { ensureDisplay } = require('./browser')

const TARGET = process.env.EVAL_LOGIN_PROFILE || process.argv[2] || 'user_data_main'
const PROFILE = path.isAbsolute(TARGET) ? TARGET : path.join(__dirname, TARGET)

// 登录必须在**可见窗口**中人工操作，因此优先使用完整 chromium。
// chrome-headless-shell 是纯无头构建，即使 headless:false 也不会渲染窗口。
const BROWSER_PATHS = [
    process.env.EVAL_LOGIN_BROWSER,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/lib/chromium/chromium',
    '/ql/data/dep_cache/node/headless-shell/bin/chrome-headless-shell',
].filter(Boolean)

function findBrowser() {
    for (const p of BROWSER_PATHS) {
        if (fs.existsSync(p)) return p
    }
    return null
}

;(async () => {
    console.log('==================================================')
    console.log(`${LogTag.SYSTEM} 京东登录初始化 (login-setup)`)
    console.log('==================================================')
    console.log(`${LogTag.SYSTEM} profile 目录: ${PROFILE}`)

    // 自动准备虚拟显示器（默认 :99）
    const disp = ensureDisplay()
    console.log(`${LogTag.SYSTEM} 显示器: ${disp}`)

    const exe = findBrowser()
    if (!exe) {
        console.log(`${LogTag.SYSTEM} ❌ 未找到可用浏览器`)
        console.log(`${LogTag.SYSTEM} 登录需要完整版 chromium（不是 chrome-headless-shell）`)
        process.exit(1)
    }
    if (/headless-shell/.test(exe)) {
        console.log(`${LogTag.SYSTEM} ⚠ 当前只有 chrome-headless-shell，它是纯无头构建，`)
        console.log(`${LogTag.SYSTEM}   无法显示窗口，将看不到登录页面。`)
        console.log(`${LogTag.SYSTEM}   请先安装完整 chromium：apt-get install -y chromium`)
        process.exit(1)
    }

    await fs.ensureDir(PROFILE)
    // 清理上次异常退出的锁文件
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { await fs.remove(path.join(PROFILE, lock)) } catch (_) { }
    }

    console.log(`${LogTag.SYSTEM} 浏览器: ${exe}`)
    console.log('')
    console.log('──────────────────────────────────────────────')
    console.log('  请通过 VNC 打开桌面，在浏览器中完成京东登录')
    console.log('  扫码 / 短信验证码 / 账号密码 均可，滑块请手动拖')
    console.log('  登录成功后本脚本会自动检测并保存，无需手动操作')
    console.log('──────────────────────────────────────────────')
    console.log('')

    let ctx
    try {
        ctx = await chromium.launchPersistentContext(PROFILE, {
            headless: false,                     // 必须有头，才能人工操作
            executablePath: exe,
            viewport: null,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--lang=zh-CN',
                '--window-position=0,0',
                '--window-size=1440,900',
                '--disable-infobars',
                '--disable-session-crashed-bubble',
                '--hide-crash-restore-bubble',
            ],
        })

        const page = ctx.pages()[0] || await ctx.newPage()
        page.setDefaultTimeout(90000)

        // 已登录就直接复用
        const existing = await ctx.cookies()
        const hasSession = existing.some(c => /jd\.com/.test(c.domain) && (c.name === 'thor' || c.name === 'pt_key'))
        if (hasSession) {
            console.log(`${LogTag.LOGIN} 检测到该 profile 已有登录会话`)
        }

        console.log(`${LogTag.LOGIN} 正在打开京东评价中心...`)
        await page.goto('https://comment.m.jd.com/pc-static/center', {
            waitUntil: 'domcontentloaded',
            timeout: 120000,
        }).catch(() => { })

        console.log(`${LogTag.LOGIN} 页面已打开，等待人工登录完成...`)
        console.log(`${LogTag.LOGIN} （最长等待 30 分钟，登录成功后自动退出）`)

        // 轮询检测登录成功
        const deadline = Date.now() + 30 * 60 * 1000
        let ok = false
        while (Date.now() < deadline) {
            await sleep(4000)
            const cookies = await ctx.cookies()
            const m = {}
            for (const c of cookies) {
                if (/jd\.com$/i.test(c.domain.replace(/^\./, ''))) m[c.name] = c.value
            }
            const hasThor = (m.thor || '').length > 100
            if (hasThor) {
                // 进一步确认能进评价中心
                const url = page.url()
                if (/passport\.jd\.com/.test(url)) {
                    // 登录态有了但页面还在登录页，等待跳转
                    continue
                }
                const state = await page.evaluate(() => ({
                    rateBtns: document.querySelectorAll('.rate-btn').length,
                    nick: (document.querySelector('[class*="shortcut_user"]') || {}).innerText || '',
                    needLogin: /请登录|免费注册/.test(document.body.innerText || ''),
                })).catch(() => null)

                if (state && !state.needLogin) {
                    console.log('')
                    console.log('──────────────────────────────────────────────')
                    console.log(`${LogTag.LOGIN} ✅ 登录成功！`)
                    if (state.nick) console.log(`${LogTag.LOGIN}    账号: ${state.nick.trim().split('\n')[0]}`)
                    console.log(`${LogTag.LOGIN}    待评价商品: ${state.rateBtns} 个`)
                    console.log(`${LogTag.LOGIN}    profile 已保存: ${PROFILE}`)
                    console.log('──────────────────────────────────────────────')
                    console.log('')
                    console.log(`${LogTag.SYSTEM} 现在可以运行主脚本了：`)
                    console.log(`${LogTag.SYSTEM}   EVAL_DRY_RUN=true node index.js`)
                    ok = true
                    break
                }
            }
        }

        if (!ok) {
            console.log(`${LogTag.LOGIN} ❌ 等待超时（30 分钟），未检测到登录成功`)
            process.exitCode = 1
        }
    } catch (e) {
        console.log(`${LogTag.SYSTEM} ❌ 异常: ${e.message}`)
        process.exitCode = 1
    } finally {
        if (ctx) {
            try { await ctx.close() } catch (_) { }
        }
    }
})()
