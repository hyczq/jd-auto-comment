/**
 * ImageProc - 图片去重处理
 *
 * 京东会用感知哈希（pHash/dHash）比对重复图。单纯缩放+重编码只能改变
 * 文件字节，像素结构几乎不变，哈希仍然相同，因此会被判重复。
 *
 * 本模块做多维度像素级扰动，并自带感知哈希自检：
 *   1. 随机裁切边缘（改变构图与构图边界）
 *   2. 轻微旋转 + 扩边（改变像素网格对齐）
 *   3. 镜像翻转（概率性，大幅改变哈希）
 *   4. 微调亮度/饱和度/色相
 *   5. 轻微锐化或模糊（改变高频细节）
 *   6. 叠加极低透明度噪点/色块（打散直方图）
 *   7. 随机 JPEG 质量重编码
 *   之后用 dHash 自检，确认与原图哈希差值足够大。
 */

const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const { LogTag } = require('./utils')

/** 简易随机整数 */
function ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
/** 随机浮点 */
function rf(min, max) { return Math.random() * (max - min) + min }
/** 按概率返回 true */
function chance(p) { return Math.random() < p }

/**
 * 计算 dHash（差值哈希，64 位）
 * 抗缩放、抗轻微色彩变化，是常见的重复图判定依据之一
 * @param {Buffer} buf 原始 RGB 像素数据
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {string} 64 位十六进制哈希
 */
function dHashFromRaw(buf, w, h) {
    // 8x9 灰度网格 → 每行相邻比较得 8x8 = 64 bit
    const bits = []
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const i1 = ((y * 9 + x) * 3)
            const i2 = ((y * 9 + x + 1) * 3)
            const g1 = buf[i1] * 0.299 + buf[i1 + 1] * 0.587 + buf[i1 + 2] * 0.114
            const g2 = buf[i2] * 0.299 + buf[i2 + 1] * 0.587 + buf[i2 + 2] * 0.114
            bits.push(g1 > g2 ? 1 : 0)
        }
    }
    // 打包成 16 个 hex 字符
    let hex = ''
    for (let i = 0; i < 64; i += 4) {
        const v = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
        hex += v.toString(16)
    }
    return hex
}

/** 两哈希的汉明距离 */
function hamming(h1, h2) {
    if (h1.length !== h2.length) return 64
    let d = 0
    for (let i = 0; i < h1.length; i++) {
        let a = parseInt(h1[i], 16)
        let b = parseInt(h2[i], 16)
        let x = a ^ b
        while (x) { d += x & 1; x >>= 1 }
    }
    return d
}

class ImageProc {
    constructor(sharp) {
        this.sharp = sharp
    }

    /**
     * 取图片的 dHash（先缩到 9x8 灰度再算）
     */
    async hashOf(fileOrBuffer) {
        const { data, info } = await this.sharp(fileOrBuffer)
            .removeAlpha()
            .resize(9, 8, { fit: 'fill' })
            .raw()
            .toBuffer({ resolveWithObject: true })
        return dHashFromRaw(data, info.width, info.height)
    }

    /**
     * 生成一张带透明度的噪点图（直接构造 RGBA raw，避免 ensureAlpha 兼容问题）
     * @param {number} w 宽
     * @param {number} h 高
     * @param {number} alpha 0~1 透明度
     */
    async noiseTile(w, h, alpha) {
        const px = w * h
        const buf = Buffer.allocUnsafe(px * 4)
        const a = Math.max(0, Math.min(1, alpha)) * 255
        for (let i = 0; i < px; i++) {
            const v = ri(110, 150)
            const o = i * 4
            buf[o] = v
            buf[o + 1] = v
            buf[o + 2] = v
            buf[o + 3] = a
        }
        return this.sharp(buf, { raw: { width: w, height: h, channels: 4 } })
            .png()
            .toBuffer()
    }

    /**
     * 对单张图片做去重处理
     * @param {string} src 源文件
     * @param {string} dst 目标文件
     * @param {Object} opt { minHamming }
     * @returns {Promise<{ok:boolean, hamming:number, applied:string[]}>}
     */
    async process(src, dst, opt = {}) {
        const minHamming = opt.minHamming ?? Number(process.env.EVAL_DEDUP_HAMMING || 12)
        const srcHash = await this.hashOf(src)
        const applied = []

        // 最多试 4 轮，逐步加强扰动，直到哈希差异达标
        for (let attempt = 0; attempt < 4; attempt++) {
            const strength = 1.2 + attempt * 0.8   // 每轮加强
            try {
                let img = this.sharp(src).rotate()   // 依 EXIF 纠正
                const meta = await img.metadata()
                const W = meta.width || 1000
                const H = meta.height || 1000

                // 1) 随机边缘裁切：1.5%~5%，改变构图边界
                const cutPct = rf(0.015, 0.05) * strength
                const cutX = Math.min(Math.round(W * cutPct), Math.round(W * 0.2))
                const cutY = Math.min(Math.round(H * cutPct), Math.round(H * 0.2))
                const cw = Math.max(64, W - cutX * 2)
                const ch = Math.max(64, H - cutY * 2)
                img = img.extract({ left: cutX, top: cutY, width: cw, height: ch })
                applied.push('crop')

                // 2) 概率性镜像翻转：对哈希影响最大
                if (chance(0.65)) { img = img.flop(); applied.push('flop') }
                if (chance(0.15)) { img = img.flip(); applied.push('flip') }

                // 3) 轻微旋转 + 扩边，改变像素网格
                const deg = rf(-1.2, 1.2) * strength
                img = img.rotate(deg, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
                applied.push('rotate')

                // 4) 亮度/饱和度/色相微调
                img = img.modulate({
                    brightness: rf(0.97, 1.04),
                    saturation: rf(0.94, 1.07),
                    hue: Math.round(rf(-4, 4) * strength),
                })
                applied.push('modulate')

                // 5) 高频细节扰动：锐化 或 轻微模糊
                if (chance(0.55)) { img = img.sharpen({ sigma: rf(0.5, 0.9) }); applied.push('sharpen') }
                else { img = img.blur(rf(0.3, 0.6)); applied.push('blur') }

                // 6) 归一化尺寸，避免超过京东上限
                const maxSide = 1080
                const scaled = img.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
                applied.push('resize')

                // 7) 叠加极低透明度噪点
                const buf1 = await scaled.jpeg({ quality: 92 }).toBuffer()
                const m1 = await this.sharp(buf1).metadata()
                const noise = await this.noiseTile(m1.width, m1.height, rf(0.04, 0.09))
                let composed = this.sharp(buf1).composite([{ input: noise, blend: 'overlay' }])
                applied.push('noise')

                // 8) 随机质量重编码
                const q = ri(80, 92)
                const outBuf = await composed.jpeg({ quality: q, mozjpeg: true }).toBuffer()
                applied.push('jpeg' + q)

                // 自检：哈希差异是否足够
                const bufHash = await this.hashOf(outBuf)
                const dist = hamming(srcHash, bufHash)

                if (dist >= minHamming || attempt === 3) {
                    fs.ensureDirSync(path.dirname(dst))
                    fs.writeFileSync(dst, outBuf)
                    const st = fs.statSync(dst)
                    if (st.size < 8000) {
                        // 太小说明压过头，退回原图（宁可用原图也不传坏图）
                        console.log(`${LogTag.IMAGE} 处理结果过小(${st.size}B)，改用原图`)
                        return { ok: false, hamming: dist, applied, reason: 'too_small' }
                    }
                    return { ok: true, hamming: dist, applied: [...new Set(applied)] }
                }

                // 差异不够，下一轮加强
                console.log(`${LogTag.IMAGE} 哈希差异 ${dist} < ${minHamming}，加强扰动重试`)
            } catch (e) {
                console.log(`${LogTag.IMAGE} 处理异常(第${attempt + 1}轮): ${e.message}`)
            }
        }
        return { ok: false, hamming: 0, applied, reason: 'exhausted' }
    }

    /**
     * 批量处理
     * @param {string[]} files
     * @param {string} outDir
     * @returns {Promise<string[]>} 处理后的文件路径（失败项保留原图）
     */
    async processAll(files, outDir) {
        await fs.ensureDir(outDir)
        const out = []
        for (const f of files) {
            const base = path.basename(f).replace(/\.[^.]+$/, '')
            const dst = path.join(outDir, `${base}_u.jpg`)
            const r = await this.process(f, dst)
            if (r.ok) {
                console.log(`${LogTag.IMAGE} 去重处理完成：哈希差异 ${r.hamming}，手段 [${r.applied.join(',')}]`)
                out.push(dst)
            } else {
                console.log(`${LogTag.IMAGE} 去重处理未达标(${r.reason})，使用原图`)
                out.push(f)
            }
        }
        return out
    }
}

module.exports = { ImageProc, dHashFromRaw, hamming }
