/**
 * jd-auto-comment —— 京东自动评价 + 晒图（浏览器版）
 *
 * 用 Playwright 持久化 profile 直接操作页面 DOM。
 *
 * 登录复用 userDataDir 中已保存的浏览器会话：
 * 京东对数据中心 IP 启用 jcap 设备风控，账号密码登录会被滑块拦截，
 * 因此登录动作需人工完成一次，脚本负责后续自动化。
 *
 * 账号配置（accounts.json）：
 *   [{ "name": "主账号", "userDataDir": "user_data_main" }]
 */

const path = require('path')

const BrowserManager = require('./browser')
const { AccountStorage, AuthManager } = require('./login')
const { ReviewManager } = require('./review')
const { LogTag, sleep, rand } = require('./utils')

const VERSION = 'v1.2.0'

/**
 * 处理单个账号
 * @param {{index:number, name:string, userDataDir:string}} account
 */
async function processAccount(account) {
    console.log('==================================================')
    console.log(`${LogTag.ACCOUNT} 处理账号 ${account.index}: ${account.name}`)
    console.log('==================================================')

    const stat = {
        index: account.index,
        name: account.name,
        pending: 0,
        commented: 0,
        failed: 0,
        images: 0,
        errors: [],
    }

    const userDataDir = path.isAbsolute(account.userDataDir)
        ? account.userDataDir
        : path.join(__dirname, account.userDataDir)

    const browser = new BrowserManager(userDataDir)

    try {
        await browser.init()

        // 登录态检查（只复用 profile，不自动登录）
        const auth = new AuthManager(browser.getPage(), browser)
        if (!(await auth.ensureLoggedIn())) {
            console.log(`${LogTag.LOGIN} ▶ 请手动登录一次后重试：`)
            console.log(`${LogTag.LOGIN}   ssh -L 6080:127.0.0.1:6080 root@<服务器IP>`)
            console.log(`${LogTag.LOGIN}   浏览器打开 http://127.0.0.1:6080/vnc.html`)
            stat.errors.push('会话失效')
            return stat
        }

        // 评价
        const review = new ReviewManager(browser, stat)
        const orders = await review.fetchPendingOrders()
        stat.pending = orders.length
        console.log(`${LogTag.READ} 待评价商品 ${orders.length} 个`)

        if (!orders.length) {
            console.log(`${LogTag.READ} 没有待评价商品，跳过`)
            return stat
        }

        const limit = parseLimit(process.env.EVALNUM, 5)
        const targets = orders.slice(0, limit)

        for (let i = 0; i < targets.length; i++) {
            const order = targets[i]
            console.log(`\n${LogTag.REVIEW} [${i + 1}/${targets.length}] 第 ${order.index + 1} 个待评价商品`)
            try {
                const res = await review.commentOne(order)
                if (res.ok) {
                    stat.commented++
                    stat.images += res.images || 0
                    console.log(res.dryRun
                        ? `${LogTag.REVIEW} 🔍 预检通过（已填表+配图 ${res.images || 0} 张，未发布）`
                        : `${LogTag.REVIEW} ✅ 评价成功（配图 ${res.images || 0} 张）`)
                } else {
                    stat.failed++
                    stat.errors.push(res.reason || '未知失败')
                    console.log(`${LogTag.REVIEW} ❌ 评价失败: ${res.reason}`)
                }
            } catch (e) {
                stat.failed++
                stat.errors.push(e.message)
                console.log(`${LogTag.REVIEW} ❌ 异常: ${e.message}`)
                await browser.screenshot('review_error')
            }
            await sleep(rand(3000, 8000))
        }
    } catch (e) {
        console.log(`${LogTag.SYSTEM} 账号${account.index} 异常: ${e.message}`)
        stat.errors.push(e.message)
        await browser.screenshot('account_error')
    } finally {
        await browser.cleanup()
    }

    return stat
}

/**
 * 解析每次评价的商品数量上限
 * @param {string|undefined} raw 环境变量原值
 * @param {number} def 默认值
 * @returns {number} 正整数
 */
function parseLimit(raw, def) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return def
    const n = Number(String(raw).trim())
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        console.log(`${LogTag.SYSTEM} EVALNUM=${raw} 无效（需正整数），使用默认 ${def}`)
        return def
    }
    return n
}

/** 主流程 */
async function main() {
    console.log('==================================================')
    console.log(`jd-auto-comment ${VERSION}  京东自动评价+晒图`)
    console.log('==================================================')

    const accountsFile = process.env.AUTOCOMMENT_ACCOUNTS || path.join(__dirname, 'accounts.json')
    const accounts = await AccountStorage.getAccounts(accountsFile)

    if (!accounts.length) {
        console.log(`${LogTag.SYSTEM} 未找到有效账号`)
        console.log('请在 accounts.json 中配置 profile 目录，格式：')
        console.log('[{"name":"主账号","userDataDir":"user_data_main"}]')
        return
    }

    console.log(`${LogTag.SYSTEM} 共 ${accounts.length} 个账号`)
    console.log(`${LogTag.SYSTEM} 每账号最多评价 ${parseLimit(process.env.EVALNUM, 5)} 个商品（EVALNUM 可调）`)
    if (String(process.env.EVAL_DRY_RUN || '').toLowerCase() === 'true') {
        console.log(`${LogTag.SYSTEM} DRY RUN 模式：只填表不发布`)
    }

    const stats = []
    for (const account of accounts) {
        try {
            stats.push(await processAccount(account))
        } catch (e) {
            console.log(`${LogTag.SYSTEM} 账号${account.index} 未捕获异常: ${e.message}`)
            stats.push({
                index: account.index, name: account.name,
                pending: 0, commented: 0, failed: 0, images: 0,
                errors: [e.message],
            })
        }
    }

    // 汇总
    console.log('\n==================================================')
    console.log(`${LogTag.SUMMARY} 任务总结`)
    console.log('==================================================')
    let tP = 0, tC = 0, tF = 0, tI = 0
    for (const s of stats) {
        console.log(`账号${s.index} ${s.name}: 待评价${s.pending} 成功${s.commented} 失败${s.failed} 配图${s.images}`)
        if (s.errors.length) console.log(`  错误: ${s.errors.slice(0, 3).join(' | ')}`)
        tP += s.pending; tC += s.commented; tF += s.failed; tI += s.images
    }
    console.log(`\n合计: 待评价${tP} 成功${tC} 失败${tF} 配图${tI}`)

    if (process.env.AUTOCOMMENT_NOTIFY !== 'false') {
        await notify(`合计成功 ${tC}，失败 ${tF}，配图 ${tI}`)
    }
}

/** 发送通知 */
async function notify(content) {
    try {
        const { sendNotify } = require('./sendNotify')
        await sendNotify('京东自动评价', content)
    } catch (_) { }
}

main().catch(e => {
    console.error(`${LogTag.SYSTEM} 致命错误: ${e.stack || e.message}`)
    process.exit(1)
})
