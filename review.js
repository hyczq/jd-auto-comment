/**
 * Review - 京东评价 + 晒图核心逻辑（纯浏览器操作）
 *
 * 全部交互通过页面 DOM 完成，不调用签名接口。
 *   待评价列表: https://comment.m.jd.com/pc-static/center
 *   评价表单:   https://comment.m.jd.com/pc-static/publish?orderId=..&skuId=..&commentType=1
 */

const path = require('path')
const { LogTag, JD_URLS, sleep, rand, pick } = require('./utils')
const { ImageFetch } = require('./imagefetch')
const { AIText } = require('./aitext')

// 默认评语库（EVAL_WORD 可覆盖）
const DEFAULT_TEXTS = [
    '质量很好，和描述一致，物流也快，包装仔细，整体很满意，会回购的。',
    '收到就用了，做工不错，细节到位，这个价格很实惠，推荐给需要的朋友。',
    '东西挺好的，用了一段时间没什么问题，发货速度快，包装完好无损。',
    '和图片描述一致，材质摸着有质感，客服态度也好，整体购物体验不错。',
    '物流给力，隔天就到了。商品质量过关，没有磕碰，性价比挺高的。',
]

// ===== 页面选择器 =====
const SEL = {
    // 待评价列表
    CENTER_RATE_BTN: '.rate-btn',          // 「去评价」按钮（DIV.rate-btn）
    // 评价表单
    TEXTAREA: 'textarea.rate-comment-content-textarea', // 500 字上限
    FILE_INPUT: 'input.uploadAddInput',    // accept="video/*, image/png, image/jpeg, image/jpg"
    SUBMIT: '.rate-publish-submit-button', // DIV，文本「发布」
    STAR_BOX_ITEM: '.scoreBox-conter-score-star-box-item', // 5 个评分星
}

class ReviewManager {
    constructor(browser, stat = {}) {
        this.browser = browser
        this.page = browser.getPage()
        this.stat = stat
        this.texts = this.loadTexts()
        this.imageCount = Number(process.env.EVAL_IMG_COUNT || 2)
        this.dryRun = String(process.env.EVAL_DRY_RUN || '').toLowerCase() === 'true'
        this.ctx = browser.getContext()
        this.imgFetch = new ImageFetch(this.page)
        this.ai = AIText.fromEnv()
        // 本次运行已用过的评语，喂给 AI 做“避免雷同”参考
        this.usedTexts = []
    }

    loadTexts() {
        const custom = (process.env.EVAL_WORD || '').split('@').map(s => s.trim()).filter(Boolean)
        return custom.length ? custom : DEFAULT_TEXTS
    }

    /** 判断当前页是否被踢到登录页 */
    isLoginPage(url = this.page.url()) {
        return /passport\.jd\.com/.test(url)
    }

    /** 登录态检查 */
    async ensureLoggedIn() {
        try {
            await this.page.goto(JD_URLS.CENTER, { waitUntil: 'domcontentloaded', timeout: 90000 })
            await sleep(rand(6000, 9000))

            if (this.isLoginPage()) {
                console.log(`${LogTag.LOGIN} 跳转到登录页，profile 登录态无效`)
                await this.browser.screenshot('login_required')
                return false
            }

            // 从页面抓昵称
            const nick = await this.page.evaluate(() => {
                const el = document.querySelector('.shortcut_userico3, [class*="shortcut_user"]')
                if (el && el.innerText) return el.innerText.trim().split('\n')[0]
                return ''
            }).catch(() => '')

            // 等列表骨架出现，确认真的登录了
            const ok = await this.page.waitForSelector(
                `${SEL.CENTER_RATE_BTN}, [class*="rate-btn"], [class*="empty"]`,
                { timeout: 30000 }
            ).then(() => true).catch(() => false)

            console.log(`${LogTag.LOGIN} 登录态有效${nick ? '，账号: ' + nick : ''}${ok ? '' : '（未检测到按钮，可能无待评价）'}`)
            return true
        } catch (e) {
            console.log(`${LogTag.LOGIN} 登录检查异常: ${e.message}`)
            return false
        }
    }

    /**
     * 抓取待评价商品列表
     * 页面是 SPA，从「去评价」按钮反推不了 orderId，
     * 所以这里返回按钮句柄索引，点击时再取真实 URL。
     */
    async fetchPendingOrders() {
        try {
            // 已在 center 页就不重复导航
            if (!/pc-static\/center/.test(this.page.url())) {
                await this.page.goto(JD_URLS.CENTER, { waitUntil: 'domcontentloaded', timeout: 90000 })
                await sleep(rand(6000, 9000))
            }

            if (this.isLoginPage()) {
                console.log(`${LogTag.READ} 待评价页被重定向到登录页`)
                return []
            }

            await this.page.waitForSelector(SEL.CENTER_RATE_BTN, { timeout: 30000 }).catch(() => {})
            await sleep(1500)

            // 提取商品名，按「去评价」按钮顺序对齐
            const items = await this.page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('.rate-btn'))
                return btns.map((b, i) => {
                    // 往上找到卡片容器
                    let box = b
                    for (let k = 0; k < 8 && box; k++) box = box.parentElement
                    let name = ''
                    if (box) {
                        const el = box.querySelector('[class*="goods-title"], [class*="title"], img[alt]')
                        name = el ? (el.innerText || el.getAttribute('alt') || '').trim() : ''
                    }
                    return { index: i, wareName: name.slice(0, 60) }
                })
            })

            return items
        } catch (e) {
            console.log(`${LogTag.READ} 抓取待评价失败: ${e.message}`)
            await this.browser.saveHTML('pending_error')
            return []
        }
    }

    /**
     * 打开第 index 个待评价项的评价页
     * 「去评价」会在新标签页打开 publish 页，需要接住 popup
     */
    async openPublishPage(index) {
        const before = this.ctx.pages().length
        const btn = this.page.locator(SEL.CENTER_RATE_BTN).nth(index)

        await btn.scrollIntoViewIfNeeded().catch(() => { })
        await sleep(rand(400, 900))

        // 尝试接住 popup
        const popupPromise = this.ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null)
        await btn.click({ timeout: 20000 })
        let popup = await popupPromise

        if (popup) {
            await popup.waitForLoadState('domcontentloaded').catch(() => { })
            await sleep(rand(5000, 8000))
            return popup
        }

        // 没 popup：可能同页跳转
        await sleep(rand(4000, 6000))
        const after = this.ctx.pages().length
        if (after > before) {
            const p = this.ctx.pages()[after - 1]
            await p.waitForLoadState('domcontentloaded').catch(() => { })
            await sleep(rand(4000, 6000))
            return p
        }
        if (/pc-static\/publish/.test(this.page.url())) return this.page

        return null
    }

    /**
     * 评价单个商品
     * @param {{index:number, wareName:string}} order
     */
    async commentOne(order) {
        let page = null
        try {
            page = await this.openPublishPage(order.index)
            if (!page) {
                await this.browser.screenshot('no_publish_page')
                await this.refreshCenter()
                return { ok: false, reason: '未能打开评价页' }
            }

            if (this.isLoginPage(page.url())) {
                await this.closeExtra(page)
                return { ok: false, reason: '评价页被重定向到登录页' }
            }

            console.log(`${LogTag.REVIEW} 评价页: ${page.url().split('?')[0]}...`)

            // 外卖订单走 deliveryrate 纯评分表单，没有文字框和图片上传，直接跳过
            if (/pc-static\/deliveryrate/.test(page.url())) {
                await this.closeExtra(page)
                return { ok: false, skipped: true, reason: '外卖订单，仅支持商品评价' }
            }

            // 等表单就绪
            const ready = await page.waitForSelector(SEL.TEXTAREA, { timeout: 30000 })
                .then(() => true).catch(() => false)
            if (!ready) {
                await this.browser.screenshot('form_not_ready')
                await this.closeExtra(page)
                await this.refreshCenter()
                return { ok: false, reason: '评价表单未出现' }
            }

            const payload = await this.probeForm(page)
            console.log(`${LogTag.REVIEW} 表单: 评语框✓ 评分${payload.stars}星 可上传=${payload.canUpload}`)

            // 1. 决定评语（优先级：EVAL_WORD 自定义 > AI 生成 > 买家5星好评 > 内置模板）
            const { text, source } = await this.generateText(page)
            const brief = text.length > 30 ? text.slice(0, 30) + '...' : text
            console.log(`${LogTag.REVIEW} 评语来源: ${source}（${text.length} 字）`)
            console.log(`${LogTag.REVIEW} 评语内容: ${brief}`)

            // 2. 填写评语
            await this.fillText(page, text)

            // 3. 晒图：按奖励要求取 Math.max(2, n) 张同商品买家实拍图
            let images = 0
            if (payload.canUpload && String(process.env.EVAL_NO_IMAGE || '') !== 'true') {
                const need = await this.parseImageRequirement(page)
                images = await this.uploadImages(page, need)
            }

            if (this.dryRun) {
                console.log(`${LogTag.REVIEW} [DRY RUN] 已填表，不提交`)
                await this.browser.screenshot('dryrun_form')
                await this.closeExtra(page)
                await this.refreshCenter()
                return { ok: true, images, dryRun: true }
            }

            // 3. 提交
            const res = await this.submit(page)
            await this.closeExtra(page)
            await this.refreshCenter()
            return res.ok ? { ok: true, images } : { ok: false, reason: res.reason, images }
        } catch (e) {
            await this.browser.screenshot('comment_exception')
            if (page) await this.closeExtra(page)
            await this.refreshCenter().catch(() => { })
            return { ok: false, reason: e.message }
        }
    }

    /** 探测表单状态 */
    async probeForm(page) {
        return await page.evaluate((sel) => ({
            stars: document.querySelectorAll(sel.STAR_BOX_ITEM).length,
            canUpload: !!document.querySelector(sel.FILE_INPUT),
            hasSubmit: !!document.querySelector(sel.SUBMIT),
            maxLen: (document.querySelector(sel.TEXTAREA) || {}).maxLength || 0,
        }), SEL).catch(() => ({ stars: 0, canUpload: false, hasSubmit: false, maxLen: 0 }))
    }

    /** 填评语（用 type 触发 React 的 onInput） */
    async fillText(page, text) {
        const ta = page.locator(SEL.TEXTAREA).first()
        await ta.click({ timeout: 15000 })
        await sleep(300)
        // 先清空
        await page.keyboard.press('Control+A').catch(() => { })
        await page.keyboard.press('Backspace').catch(() => { })
        await ta.type(text, { delay: rand(25, 70) })
        await sleep(rand(700, 1400))
        console.log(`${LogTag.REVIEW} 已填写评语（${text.length} 字）`)
    }

    /** 上传图片 */
    /**
     * 评语生成：优先级 EVAL_WORD > AI > 买家5星好评 > 内置模板
     * 任意环节失败都自动降级，不影响主流程
     * @returns {Promise<{text:string, source:string}>}
     */
    async generateText(page) {
        // 1) 环境变量自定义评语（最高优先级）
        const customWords = (process.env.EVAL_WORD || '').split('@').map(x => x.trim()).filter(Boolean)
        if (customWords.length) {
            const t = pick(customWords)
            this.usedTexts.push(t)
            return { text: t, source: 'EVAL_WORD' }
        }

        // 2) AI 生成（配置了 EVAL_AI 才启用）
        if (this.ai) {
            const goods = await this.getGoodsName(page)
            const t = await this.ai.generate({ goodsName: goods, avoid: this.usedTexts })
            if (t && t.length >= 10) {
                this.usedTexts.push(t)
                return { text: t, source: `AI(${this.ai.model})` }
            }
            if (t && t.length < 10) {
                console.log(`${LogTag.REVIEW} AI 返回过短(${t.length}字)，改用备用逻辑`)
            }
        }

        // 3) 该商品买家 5 星好评
        const sku = this.extractSkuId(page)
        if (sku) {
            try {
                const cs = await this.imgFetch.fetchComments(sku, 2)
                const t = this.imgFetch.pickText(cs, Number(process.env.EVAL_WORD_COUNT || 10))
                if (t) {
                    this.usedTexts.push(t)
                    return { text: t, source: '买家5星好评' }
                }
            } catch (_) { }
        }

        // 4) 内置模板兜底
        const t = pick(this.texts)
        this.usedTexts.push(t)
        return { text: t, source: '内置模板' }
    }

    /** 从评价发布页提取商品名（供 AI 参考） */
    async getGoodsName(page) {
        try {
            return await page.evaluate(() => {
                const box = document.querySelector('[class*="rate-comment-goods"]')
                if (!box) return ''
                const el = box.querySelector('[class*="goods-title"], [class*="title"]')
                let name = el ? (el.innerText || '').trim() : ''
                if (!name) {
                    name = (box.innerText || '').split('\n')[0].trim()
                }
                return name.replace(/\s+/g, ' ').slice(0, 80)
            })
        } catch (_) { return '' }
    }

    /**
     * 上传晒图 —— 抓同商品买家实拍图
     * @param {Object} page 评价发布页
     * @param {number} need 需要的图片数
     */
    async uploadImages(page, need = 2) {
        try {
            // 1. 提取 skuId
            const sku = this.extractSkuId(page)
            if (!sku) {
                console.log(`${LogTag.IMAGE} 未取到 skuId，跳过晒图`)
                return 0
            }

            // 2. 从买家评价抓实拍图（换大图 + 重压缩）
            const tmpDir = path.join(__dirname, 'tmp_images')
            const comments = await this.imgFetch.fetchComments(sku, 3)
            if (!comments.length) {
                console.log(`${LogTag.IMAGE} 该商品暂无可用评价，跳过晒图`)
                return 0
            }

            const urls = this.imgFetch.pickImages(comments, Math.max(need, 2))
            console.log(`${LogTag.IMAGE} 找到 ${urls.length} 张买家实拍图`)
            if (!urls.length) {
                console.log(`${LogTag.IMAGE} 评价里没有实拍图，跳过晒图（避免与商品不符被驳回）`)
                return 0
            }

            const raw = await this.imgFetch.download(urls, tmpDir, 'buyer')
            const ready = await this.imgFetch.reprocess(raw, tmpDir)
            const use = ready.slice(0, need)
            if (!use.length) {
                console.log(`${LogTag.IMAGE} 图片准备失败，跳过晒图`)
                return 0
            }

            // 3. 上传
            const input = page.locator(SEL.FILE_INPUT).first()
            await input.setInputFiles(use)
            await sleep(rand(7000, 10000))   // 等京东上传+审核
            console.log(`${LogTag.IMAGE} 已上传 ${use.length} 张买家实拍图`)
            return use.length
        } catch (e) {
            console.log(`${LogTag.IMAGE} 上传失败（将仅发文字）: ${e.message}`)
            return 0
        }
    }

    /** 从发布页 URL 或页面取 skuId */
    extractSkuId(page) {
        try {
            const m = String(page.url()).match(/skuId=(\d+)/)
            if (m) return m[1]
        } catch (_) { }
        return ''
    }

    /**
     * 解析该商品的奖励要求，得到需要的图片数
     * 文案示例：「写10字+1图，得 30京豆」
     */
    async parseImageRequirement(page) {
        try {
            const txt = await page.evaluate(() => {
                const b = document.querySelector('[class*="rate-comment-goods"]')
                return b ? (b.innerText || '').replace(/\s+/g, ' ') : ''
            })
            const m = txt.match(/\+(\d+)\s*图/)
            const required = m ? Number(m[1]) : 1
            const need = Math.max(2, required)   // 至少 2 张，更稳妥
            console.log(`${LogTag.IMAGE} 奖励要求: 官方${required}图 → 实际取 ${need} 张`)
            return need
        } catch (_) {
            return Math.max(2, this.imageCount)
        }
    }

    /** 提交评价 */
    async submit(page) {
        const clicked = await page.evaluate((sel) => {
            const b = document.querySelector(sel.SUBMIT)
            if (!b) return false
            b.click()
            return true
        }, SEL).catch(() => false)

        if (!clicked) return { ok: false, reason: '找不到发布按钮' }
        console.log(`${LogTag.REVIEW} 已点击发布`)

        // 轮询等待明确结果（成功时页面显示「评价成功，感谢您!」）
        for (let i = 0; i < 12; i++) {
            await sleep(2000)
            const v = await page.evaluate(() => {
                const t = (document.body.innerText || '').replace(/\s+/g, '')
                if (/评价成功|发布成功|提交成功|感谢您/.test(t)) return 'ok'
                if (/评价失败|发布失败|提交失败|请填写|请输入评价|内容不符合|网络异常|操作频繁/.test(t)) return 'fail'
                return 'wait'
            }).catch(() => 'wait')
            if (v === 'ok') {
                console.log(`${LogTag.REVIEW} 检测到成功提示`)
                return { ok: true }
            }
            if (v === 'fail') {
                const msg = await page.evaluate(() =>
                    (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)).catch(() => '')
                return { ok: false, reason: '页面提示失败: ' + msg }
            }
        }
        // 超时未检测到明确结果
        await this.browser.screenshot('submit_unknown')
        return { ok: false, reason: '等待发布结果超时，请检查 debug 截图' }
    }

    /** 关闭多余标签 */
    async closeExtra(page) {
        try {
            if (page && page !== this.page && !page.isClosed()) await page.close()
        } catch (_) { }
    }

    /** 回到待评价列表（刷新以更新剩余项） */
    async refreshCenter() {
        try {
            if (this.isLoginPage()) return
            await this.page.goto(JD_URLS.CENTER, { waitUntil: 'domcontentloaded', timeout: 90000 })
            await sleep(rand(5000, 8000))
        } catch (_) { }
    }
}

module.exports = { ReviewManager }
