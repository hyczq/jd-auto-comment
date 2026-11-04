/**
 * ImageFetch - 抓取同一商品下已有买家评价的实拍图 + 5 星好评文字
 *
 * 流程：
 *   1. 从商品评价接口按「5星 + 有图 + 最新」拉取买家晒单
 *   2. 取 Math.max(2, 奖励要求图数) 张实拍图，换成大图尺寸后重新压缩
 *   3. 评语从 5 星好评里随机挑；没有合适评语则退回内置模板
 *
 * 图源接口（需登录态）：
 *   https://club.jd.com/comment/productPageComments.action
 *     ?productId=<sku>&score=0&sortType=5&page=0&pageSize=20
 *
 * 注意：score 必须传 0。传 5 时接口返回空数组而非 5 星评价。
 */

const fs = require('fs-extra')
const path = require('path')
const { LogTag, sleep, rand, pick } = require('./utils')
const { ImageProc } = require('./imageproc')

// 差评/负面关键词，命中则排除该评语
const BLOCK_WORDS = ['垃圾', '质量差', '差评', '好差', '欺骗', '退货', '退款', '失望', '不推荐', '难吃', 'broken', 'worse']

// 360buyimg 尺寸前缀 → 想要的尺寸
const SIZE_MAP = {
    small: 's400x400',   // 中等
    big: 's800x800',     // 大图
    origin: '',          // 原图
}

class ImageFetch {
    constructor(page) {
        this.page = page
    }

    /**
     * 抓取商品评价（买家晒单）
     * @param {string} skuId
     * @param {number} maxPage
     * @returns {Promise<Array>} [{content, images:[url], score}]
     */
    async fetchComments(skuId, maxPage = 3) {
        const all = []
        let limited = false

        for (let page = 0; page < maxPage; page++) {
            try {
                const r = await this.page.evaluate(async (args) => {
                    const url = 'https://club.jd.com/comment/productPageComments.action'
                        + '?productId=' + args.sku
                        + '&score=0&sortType=5&page=' + args.page
                        + '&pageSize=20'
                    const resp = await fetch(url, { credentials: 'include' })
                    let text = ''
                    try { text = await resp.text() } catch (_) { }
                    return { status: resp.status, text }
                }, { sku: skuId, page })

                if (r.status !== 200) {
                    console.log(`${LogTag.IMAGE} 评价接口 HTTP ${r.status}`)
                    break
                }

                // 京东限流时会返回中文提示而非 JSON
                let data
                try {
                    data = JSON.parse(r.text)
                } catch (_) {
                    const snippet = String(r.text || '').replace(/\s+/g, ' ').slice(0, 40)
                    if (/活动太火爆|稍后再试|访问频繁|请稍后/.test(snippet)) {
                        console.log(`${LogTag.IMAGE} 评价接口限流（${snippet}），稍后重试`)
                        limited = true
                    } else {
                        console.log(`${LogTag.IMAGE} 评价接口返回非 JSON: ${snippet}`)
                    }
                    break
                }

                if (!Array.isArray(data.comments)) break
                all.push(...data.comments)
                if (page >= (data.maxPage || 1) - 1) break
                await sleep(rand(800, 1600))
            } catch (e) {
                console.log(`${LogTag.IMAGE} 拉评价异常(page ${page}): ${e.message}`)
                break
            }
        }

        // 限流时重试一次
        if (limited && !all.length) {
            console.log(`${LogTag.IMAGE} 等待 3 秒后重试评价接口`)
            await sleep(3000)
            try {
                const r = await this.page.evaluate(async (args) => {
                    const url = 'https://club.jd.com/comment/productPageComments.action'
                        + '?productId=' + args.sku
                        + '&score=0&sortType=5&page=0&pageSize=20'
                    const resp = await fetch(url, { credentials: 'include' })
                    const text = await resp.text()
                    return { status: resp.status, text }
                }, { sku: skuId })
                if (r.status === 200) {
                    const d = JSON.parse(r.text)
                    if (Array.isArray(d.comments)) {
                        all.push(...d.comments)
                        console.log(`${LogTag.IMAGE} 重试成功，拿到 ${d.comments.length} 条评价`)
                    }
                }
            } catch (_) { }
        }

        return all
    }

    /**
     * 从评价列表挑出「可用实拍图」
     * 排除：小尺寸/低质量、疑似截图
     */
    pickImages(comments, need) {
        const urls = []
        for (const c of comments) {
            if (Number(c.score) !== 5) continue
            for (const im of (c.images || [])) {
                const raw = im && im.imgUrl
                if (!raw) continue
                if (urls.length >= need) break
                const u = this.normalizeUrl(raw, 'big')
                if (u && !urls.includes(u)) urls.push(u)
            }
            if (urls.length >= need) break
        }
        return urls
    }

    /**
     * 从 5 星好评挑评语（过滤差评词、过短、含联系方式）
     */
    pickText(comments, minLen = 10) {
        const cands = []
        for (const c of comments) {
            if (Number(c.score) !== 5) continue
            const t = String(c.content || '').replace(/\s+/g, ' ').trim()
            if (t.length < minLen) continue
            if (BLOCK_WORDS.some(w => t.includes(w))) continue
            // 排除含联系方式/链接的
            if (/http|www\.|微信|qq|加我|电话|\d{8,}/i.test(t)) continue
            cands.push(t.slice(0, 480)) // 上限小于 textarea 500
        }
        return cands.length ? pick(cands) : ''
    }

    /**
     * 规范化 360buyimg URL，换尺寸
     * //img30.360buyimg.com/n0/s128x96_jfs/xxx.jpg
     *   -> https://img30.360buyimg.com/n0/s800x800_jfs/xxx.jpg
     */
    normalizeUrl(raw, size = 'big') {
        try {
            let u = String(raw).trim()
            if (u.startsWith('//')) u = 'https:' + u
            if (!/^https?:/.test(u)) return ''
            const s = SIZE_MAP[size] !== undefined ? SIZE_MAP[size] : SIZE_MAP.big
            u = u.replace(/\/s\d+x\d+_jfs\//, (s ? `/${s}_jfs/` : '/jfs/'))
            return u
        } catch (_) { return '' }
    }

    /**
     * 下载图片到本地（经浏览器上下文请求，带登录态，规避防盗链）
     * @returns {Promise<string|null>} 本地路径
     */
    async download(urls, outDir, tag = 'img') {
        await fs.ensureDir(outDir)
        const saved = []
        for (let i = 0; i < urls.length; i++) {
            const u = urls[i]
            try {
                const b64 = await this.page.evaluate(async (src) => {
                    const resp = await fetch(src, { credentials: 'omit' })
                    if (!resp.ok) return null
                    const buf = await resp.arrayBuffer()
                    let s = ''
                    const bytes = new Uint8Array(buf)
                    for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k])
                    return btoa(s)
                }, u)
                if (!b64) { console.log(`${LogTag.IMAGE} 下载失败: ${u.slice(0, 60)}`); continue }
                const buf = Buffer.from(b64, 'base64')
                // 尺寸过滤：太小的图（截图/图标）跳过
                if (buf.length < 12000) {
                    console.log(`${LogTag.IMAGE} 跳过过小图片(${buf.length}B)`)
                    continue
                }
                const ext = /\.png/i.test(u) ? 'png' : 'jpg'
                const file = path.join(outDir, `${tag}_${Date.now()}_${i}.${ext}`)
                await fs.writeFile(file, buf)
                saved.push(file)
                console.log(`${LogTag.IMAGE} 下载 ${i + 1}/${urls.length} (${Math.round(buf.length / 1024)}KB)`)
            } catch (e) {
                console.log(`${LogTag.IMAGE} 下载异常: ${e.message}`)
            }
        }
        return saved
    }

    /**
     * 去重处理：交给 ImageProc 做多维度像素扰动 + 哈希自检
     * @param {string[]} files 原图路径
     * @param {string} outDir 输出目录
     * @returns {Promise<string[]>} 处理后的路径（失败项退回原图）
     */
    async reprocess(files, outDir) {
        let sharp
        try {
            sharp = require('sharp')
        } catch (_) {
            console.log(`${LogTag.IMAGE} 未安装 sharp，跳过去重处理`)
            return files
        }
        const proc = new ImageProc(sharp)
        return await proc.processAll(files, outDir)
    }

}

module.exports = { ImageFetch }
