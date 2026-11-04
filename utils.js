/**
 * Utils - 常量、日志与工具函数
 */

const LogTag = {
    SYSTEM: '[System]',
    LOGIN: '[Login]',
    ACCOUNT: '[Account]',
    READ: '[Read]',
    REVIEW: '[Review]',
    IMAGE: '[Image]',
    SUMMARY: '[Summary]',
}

// 京东页面地址
const JD_URLS = {
    // 评价中心：待评价 + 已评价列表（SPA，页面内 .rate-btn 为「去评价」）
    CENTER: 'https://comment.m.jd.com/pc-static/center',
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

module.exports = { LogTag, JD_URLS, sleep, rand, pick }
