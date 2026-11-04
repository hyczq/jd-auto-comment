/**
 * AIText - AI 生成评语（可选）
 *
 * 支持任意 OpenAI 兼容接口（OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等）。
 * 未配置时本模块不启用，调用方自动退回原有逻辑。
 *
 * 环境变量（只需一个）：
 *   EVAL_AI=<接口地址>;<API密钥>;<模型名>
 *
 * 示例：
 *   EVAL_AI=https://api.deepseek.com/v1/chat/completions;sk-xxxx;deepseek-flash
 */

const { LogTag } = require('./utils')

// 请求超时（秒），内部固定值
const AI_TIMEOUT = 30

// ===== 提示词 =====
const SYSTEM_PROMPT = `你是一个真实的京东购物用户，正在为刚收到的商品写评价。
要求：
1. 用第一人称，语气自然口语化，像真人随手写的，不要像广告文案。
2. 只写评语正文，不要任何解释、前缀（如"评价："）、引号或 Markdown 标记。
3. 不要提及具体价格数字、订单号、物流单号、客服姓名等可能泄露隐私的信息。
4. 不要出现"京东""商家""卖家"等平台方称呼，说"物流快""包装好"即可。
5. 不要使用"总的来说""综上所述""这款产品"这类书面语。
6. 不要编造商品不具备的功能或特性。
7. 长度控制在 30~120 字，一段话，不要换行。
8. 不要包含 emoji。`

/**
 * 构建用户提示词
 * @param {Object} ctx { goodsName, avoid: string[] }
 */
function buildUserPrompt(ctx) {
    const { goodsName, avoid = [] } = ctx

    let p = `商品名称：${goodsName || '（未获取到，请写通用但自然的购物感受）'}\n`
    if (avoid.length) {
        // 只给前若干条做"避免雷同"参考，避免提示词过长
        const sample = avoid.slice(0, 3).map(s => `- ${s.slice(0, 40)}`).join('\n')
        p += `\n以下是其他买家的评价，请勿与其雷同，换一个角度和措辞：\n${sample}\n`
    }
    p += `\n请直接输出评语正文。`
    return p
}

class AIText {
    /**
     * @param {Object} cfg { url, key, model }
     */
    constructor(cfg) {
        this.url = cfg.url
        this.key = cfg.key
        this.model = cfg.model
    }

    /** 从环境变量构建；配置不全返回 null */
    static fromEnv() {
        const raw = (process.env.EVAL_AI || '').trim()
        if (!raw) return null

        // 格式：<接口地址>;<API密钥>;<模型名>
        const parts = raw.split(';').map(x => x.trim())
        const [url, key, model] = parts

        if (!url || !key || !model) {
            console.log(`${LogTag.REVIEW} EVAL_AI 格式错误，应为「地址;密钥;模型」，当前已忽略`)
            return null
        }
        if (!/^https?:\/\//i.test(url)) {
            console.log(`${LogTag.REVIEW} EVAL_AI 地址需以 http(s):// 开头，当前已忽略`)
            return null
        }
        return new AIText({ url, key, model })
    }

    /** 是否已配置 */
    static enabled() {
        return AIText.fromEnv() !== null
    }

    /**
     * 生成评语
     * @param {Object} ctx { goodsName, avoid }
     * @returns {Promise<string>} 成功返回评语，失败返回空串
     */
    async generate(ctx = {}) {
        const userPrompt = buildUserPrompt({
            goodsName: ctx.goodsName,
            avoid: ctx.avoid || [],
        })

        const body = {
            model: this.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.9,
            max_tokens: 300,
        }

        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT * 1000)

        try {
            const resp = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.key}`,
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            })

            if (!resp.ok) {
                const errText = await resp.text().catch(() => '')
                console.log(`${LogTag.REVIEW} AI 接口 HTTP ${resp.status}: ${errText.slice(0, 150)}`)
                return ''
            }

            const data = await resp.json()
            const raw = data?.choices?.[0]?.message?.content || ''
            return this.clean(raw)
        } catch (e) {
            const msg = e.name === 'AbortError' ? `超时 ${AI_TIMEOUT}s` : e.message
            console.log(`${LogTag.REVIEW} AI 生成失败: ${msg}`)
            return ''
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * 清洗模型输出：去引号/前缀/换行/emoji，限制长度
     */
    clean(text) {
        let t = String(text || '').trim()

        // 去掉常见前缀
        t = t.replace(/^(评价|评论|评语|答复|回答)[:：]\s*/,'')
        // 去掉包裹引号
        t = t.replace(/^["'“”「『]+|["'“”」』]+$/g, '')
        // 压成单段
        t = t.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
        // 去 emoji（常见区间）
        t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
        // 京东 textarea 上限 500，留余量
        if (t.length > 480) t = t.slice(0, 480)
        return t.trim()
    }
}

module.exports = { AIText, SYSTEM_PROMPT, buildUserPrompt }
