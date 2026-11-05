/**
 * Browser - 浏览器管理器（参照 bingScript/browser.js）
 */

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs-extra')
const { execSync, spawn } = require('child_process')
const { LogTag } = require('./utils')

// 浏览器可执行文件候选路径，可用 EVAL_BROWSER_PATH 环境变量指定
const browserPaths = [
    process.env.EVAL_BROWSER_PATH,
    '/ql/data/dep_cache/node/headless-shell/bin/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
].filter(Boolean)

let _cachedBrowserPath = null

// 伪装成真实 Windows Chrome
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/**
 * 查找可用浏览器
 */
function findBrowserPath() {
    if (_cachedBrowserPath) return _cachedBrowserPath
    for (const p of browserPaths) {
        if (p && fs.existsSync(p)) {
            _cachedBrowserPath = p
            return p
        }
    }
    return null
}

/**
 * 清理残留浏览器进程
 */
function killResidual() {
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /f /im chrome.exe 2>nul', { stdio: 'ignore' })
        } else {
            execSync('pkill -f chrome-headless-shell 2>/dev/null', { stdio: 'ignore' })
        }
    } catch (_) { }
}

/**
 * 确保虚拟显示器可用
 * 未设置 DISPLAY 时默认使用 :99，若该显示器未启动则自动拉起 Xvfb
 * @returns {string} 可用的 DISPLAY 值
 */
function ensureDisplay() {
    if (!process.env.DISPLAY) process.env.DISPLAY = ':99'
    const disp = process.env.DISPLAY
    if (process.platform === 'win32') return disp

    // 通过 X11 socket 判断显示器是否已就绪，避免 pgrep 自匹配问题
    const num = disp.replace(/^:/, '').split('.')[0]
    const sock = `/tmp/.X11-unix/X${num}`
    const lock = `/tmp/.X${num}-lock`

    // socket 文件可能残留（容器重启后 Xvfb 已退出但文件还在），
    // 必须用锁文件里的 pid 确认进程仍存活，否则会误判显示器可用
    if (fs.existsSync(sock)) {
        let alive = false
        try {
            const pid = Number(String(fs.readFileSync(lock, 'utf8')).trim())
            alive = !!pid && fs.existsSync(`/proc/${pid}`)
        } catch (_) { }
        if (alive) return disp
        try { fs.unlinkSync(sock) } catch (_) { }
        try { fs.unlinkSync(lock) } catch (_) { }
        console.log(`${LogTag.SYSTEM} 清理残留的 ${disp} socket 与锁`)
    }

    // 尝试自动启动 Xvfb
    try {
        const p = spawn('Xvfb', [disp, '-screen', '0', '1440x900x24', '-ac', '+extension', 'RANDR'], {
            detached: true,
            stdio: 'ignore',
        })
        p.unref()
        // 等待 socket 出现
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
            execSync('sleep 0.3')
            if (fs.existsSync(sock)) {
                console.log(`${LogTag.SYSTEM} 已自动启动 Xvfb ${disp}`)
                return disp
            }
        }
        console.log(`${LogTag.SYSTEM} Xvfb ${disp} 启动超时，请手动启动`)
    } catch (e) {
        console.log(`${LogTag.SYSTEM} 无法自动启动 Xvfb: ${e.message}`)
    }
    return disp
}

class BrowserManager {
    /**
     * @param {string} userDataDir - 持久化 profile 目录（必须已登录）
     */
    constructor(userDataDir = '') {
        this.userDataDir = userDataDir
        this.context = null
        this.page = null
    }

    async init() {
        killResidual()

        const dir = this.userDataDir
        if (!dir) throw new Error('未指定 userDataDir')
        await fs.ensureDir(dir)

        // 清理上次异常退出留下的锁文件
        for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            try { await fs.remove(path.join(dir, lock)) } catch (_) { }
        }

        const executablePath = findBrowserPath()
        if (!executablePath) {
            throw new Error('未找到可用浏览器，请检查 chrome-headless-shell 是否存在')
        }
        console.log(`${LogTag.SYSTEM} 浏览器: ${executablePath}`)

        // 自动准备虚拟显示器（默认 :99），无需手工配置 DISPLAY
        ensureDisplay()
        const headless = process.platform === 'win32' ? false : false

        this.context = await chromium.launchPersistentContext(dir, {
            headless,
            executablePath,
            viewport: { width: 1440, height: 900 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            userAgent,
            extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--lang=zh-CN',
                '--accept-lang=zh-CN,zh;q=0.9',
                '--window-size=1440,900',
                '--mute-audio',
                '--disable-infobars',
                '--disable-blink-features=AutomationControlled',
                '--renderer-process-limit=2',
                '--disable-session-crashed-bubble',
                '--hide-crash-restore-bubble',
            ],
        })

        this.page = this.context.pages()[0] || await this.context.newPage()

        // 反自动化检测
        await this.context.addInitScript(() => {
            try {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
            } catch (_) { }
        })

        // 超时设置
        this.context.setDefaultTimeout(20000)
        this.context.setDefaultNavigationTimeout(60000)
        this.page.setDefaultTimeout(20000)
        this.page.setDefaultNavigationTimeout(60000)

        console.log(`${LogTag.SYSTEM} 浏览器启动成功`)
    }

    /** 截图（排障） */
    async screenshot(tag) {
        try {
            const dir = path.join(__dirname, 'debug')
            await fs.ensureDir(dir)
            const file = path.join(dir, `${String(tag).replace(/[^\w-]/g, '_')}_${Date.now()}.png`)
            await this.page.screenshot({ path: file, fullPage: false })
            console.log(`${LogTag.SYSTEM} 截图: ${path.basename(file)}`)
            return file
        } catch (_) { return null }
    }

    /** 保存 HTML（排障） */
    async saveHTML(tag) {
        try {
            const dir = path.join(__dirname, 'debug')
            await fs.ensureDir(dir)
            const file = path.join(dir, `${String(tag).replace(/[^\w-]/g, '_')}_${Date.now()}.html`)
            await fs.writeFile(file, await this.page.content())
            return file
        } catch (_) { return null }
    }

    getPage() { return this.page }
    getContext() { return this.context }

    async goto(url) {
        if (this.page) await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    }

    getUrl() { return this.page ? this.page.url() : '' }

    async cleanup() {
        if (!this.context) return
        try { await this.context.close() } catch (_) { }
        console.log(`${LogTag.SYSTEM} 浏览器关闭`)
    }
}

module.exports = BrowserManager
module.exports.BrowserManager = BrowserManager
module.exports.findBrowserPath = findBrowserPath
module.exports.ensureDisplay = ensureDisplay
module.exports._resetBrowserPathCache = () => { _cachedBrowserPath = null }
