/**
 * Login - 登录态管理（仅支持 userDataDir 持久化 profile）
 *
 * 设计参照 bingScript 的 AccountStorage 思路：账号配置来自 accounts.json。
 *
 * 本脚本不使用账号密码登录：京东对机房 IP 启用 jcap 设备风控，
 * 点「登录」即弹滑块，密码校验根本走不到。因此登录动作由人工完成
 * （远程桌面手动登录一次），脚本只负责复用 profile 会话。
 */

const fs = require('fs-extra')
const path = require('path')
const { LogTag, JD_URLS, sleep, rand } = require('./utils')

/**
 * 账号配置（accounts.json）
 */
class AccountStorage {
    /**
     * 读取账号列表
     * @param {string} [file] accounts.json 路径
     * @returns {Promise<Array>} [{ index, name, userDataDir }]
     */
    static async getAccounts(file) {
        const p = file || path.join(__dirname, 'accounts.json')
        if (!(await fs.pathExists(p))) {
            console.log(`${LogTag.ACCOUNT} 未找到账号文件: ${path.basename(p)}`)
            return []
        }
        try {
            const data = await fs.readJson(p)
            if (!Array.isArray(data)) {
                console.log(`${LogTag.ACCOUNT} 账号文件格式错误：应为数组`)
                return []
            }
            return data
                .filter(a => a && a.userDataDir)
                .map((a, i) => ({
                    index: i + 1,
                    name: a.name || a.userDataDir.replace(/^user_data_/, ''),
                    userDataDir: a.userDataDir,
                }))
        } catch (e) {
            console.log(`${LogTag.ACCOUNT} 读取账号文件异常: ${e.message}`)
            return []
        }
    }
}

/**
 * 登录态检查
 */
class AuthManager {
    constructor(page, browserMgr) {
        this.page = page
        this.browserMgr = browserMgr
    }

    /**
     * 确认 profile 会话有效
     * @returns {Promise<boolean>}
     */
    async ensureLoggedIn() {
        if (await this.isLoggedIn()) {
            console.log(`${LogTag.LOGIN} 已登录（复用 profile 会话）`)
            return true
        }
        console.log(`${LogTag.LOGIN} profile 会话已失效`)
        await this.browserMgr.screenshot('session_expired')
        return false
    }

    /**
     * 访问评价中心，判断是否被踢回登录页
     * @returns {Promise<boolean>}
     */
    async isLoggedIn() {
        try {
            await this.page.goto(JD_URLS.CENTER, { waitUntil: 'domcontentloaded', timeout: 90000 })
            await sleep(rand(5000, 7500))

            if (/passport\.jd\.com/.test(this.page.url())) return false

            return await this.page.evaluate(() => {
                const t = document.body.innerText || ''
                if (/请登录|免费注册/.test(t) && !/退出/.test(t)) return false
                if (document.querySelector('.rate-btn')) return true
                if (document.querySelector('[class*="shortcut_user"]')) return true
                return /我的订单|待评价|已评价/.test(t)
            }).catch(() => false)
        } catch (e) {
            console.log(`${LogTag.LOGIN} 登录检查异常: ${e.message}`)
            return false
        }
    }
}

module.exports = { AccountStorage, AuthManager }
