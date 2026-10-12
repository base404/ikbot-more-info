// ==UserScript==
// @name         爱看机器人-全站海报修复与影视简介
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  为 ikanbot.com 修复全站影视海报预览图（解除豆瓣防盗链限制、拦截失效代理），并在播放页添加简介、评分及类型展示（NeoDB / WMDB 双源兜底）。
// @author       Antigravity
// @match        *://*.ikanbot.com/*
// @match        *://ikanbot.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      neodb.social
// @connect      api.wmdb.tv
// @connect      wmdb.tv
// @connect      *.doubanio.com
// @connect      doubanio.com
// @connect      *.douban.com
// @connect      douban.com
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/zepto/1.1.6/zepto.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 1. 广告弹窗与跳转拦截安全盾 (立即执行，防止劫持)
    // ==========================================

    // 1.1 拦截 window.open 弹窗
    const originalOpen = window.open;
    window.open = function (url, name, specs) {
        if (!url) return originalOpen.apply(this, arguments);
        try {
            const parsedUrl = new URL(url, window.location.href);
            // 允许放行的域名白名单：当前站、NeoDB、WMDB、Douban
            const allowedDomains = ['ikanbot.com', 'neodb.social', 'wmdb.tv', 'douban.com', 'doubanio.com'];
            const isAllowed = allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain));
            if (isAllowed) {
                return originalOpen.apply(this, arguments);
            } else {
                console.warn('[Ikanbot 增强] 已拦截可疑的 window.open 弹窗请求:', url);
                return null;
            }
        } catch (e) {
            console.warn('[Ikanbot 增强] 已拦截格式异常的 window.open 请求:', url);
            return null;
        }
    };

    // 1.2 拦截第三方广告域名超链接点击跳转
    document.addEventListener('click', function (e) {
        const anchor = e.target.closest('a');
        if (anchor && anchor.href) {
            try {
                if (anchor.href.startsWith('javascript:')) return;
                const url = new URL(anchor.href, window.location.href);
                const allowedDomains = ['ikanbot.com', 'neodb.social', 'wmdb.tv'];
                const isAllowed = allowedDomains.some(domain => url.hostname.endsWith(domain));
                if (!isAllowed) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.warn('[Ikanbot 增强] 已拦截指向第三方的广告超链接跳转:', anchor.href);
                }
            } catch (err) {
                // 忽略解析错误
            }
        }
    }, true);

    // 1.3 拦截 iframe 劫持 (限制 top 级别导航)
    function shieldIframe(iframe) {
        if (!iframe) return;
        const sandbox = iframe.getAttribute('sandbox');
        const targetSandbox = 'allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock';
        if (sandbox !== targetSandbox) {
            console.log('[Ikanbot 增强] 发现播放器 iframe，正在应用沙盒防护，禁止其导航顶层窗口...');
            if (!iframe.hasAttribute('allowfullscreen')) {
                iframe.setAttribute('allowfullscreen', 'true');
            }
            if (!iframe.hasAttribute('allow')) {
                iframe.setAttribute('allow', 'autoplay; fullscreen');
            } else {
                let allowAttr = iframe.getAttribute('allow');
                if (!allowAttr.includes('autoplay')) allowAttr += '; autoplay';
                if (!allowAttr.includes('fullscreen')) allowAttr += '; fullscreen';
                iframe.setAttribute('allow', allowAttr);
            }
            iframe.setAttribute('sandbox', targetSandbox);
        }
    }

    // 动态监听后续插入的 iframe
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.tagName === 'IFRAME') {
                    shieldIframe(node);
                } else if (node.querySelectorAll) {
                    const iframes = node.querySelectorAll('iframe');
                    iframes.forEach(shieldIframe);
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 兜底扫描
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('iframe').forEach(shieldIframe);
    });

    // ==========================================
    // 2. 全站影视海报预览图修复引擎 (立即执行，解除豆瓣防盗链 & 拦截失效代理)
    // ==========================================

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // 2.1 拦截并中和网站原生失效的图片懒加载配置 (防止将图片重写为已失效的 imgp.ikanbot.eu.org 代理或 403 占位图)
    try {
        const dummyLazyOptions = {
            elements_selector: '.ikbot-disabled-official-lazy'
        };
        Object.defineProperty(pageWin, 'lazyLoadOptions', {
            configurable: true,
            enumerable: true,
            get() {
                return dummyLazyOptions;
            },
            set(val) {
                // 静默忽略 common.js 写入的损坏代理配置
            }
        });
    } catch (e) {
        console.warn('[Ikanbot 增强] 拦截原生 lazyLoadOptions 失败:', e);
    }

    // 2.2 注入海报加载与平滑过渡样式
    function injectPosterStyles() {
        if (document.getElementById('ikbot-poster-style')) return;
        const style = document.createElement('style');
        style.id = 'ikbot-poster-style';
        style.textContent = `
            img[data-ikbot-fixed="true"] {
                opacity: 1 !important;
                transition: opacity 0.3s ease-in-out !important;
            }
            img.ikbot-loading {
                opacity: 0.6;
            }
        `;
        const target = document.head || document.documentElement;
        if (target) target.appendChild(style);
    }

    // 2.3 辅助函数：Base64URL 解码 (用于从 ikanbot 代理链接中还原豆瓣原始图片 URL)
    function decodeBase64Url(str) {
        try {
            let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4 !== 0) {
                base64 += '=';
            }
            return atob(base64);
        } catch (e) {
            return null;
        }
    }

    // 2.4 提取真实的豆瓣/影视海报原始 URL
    function extractRealImageUrl(img) {
        if (!img) return '';
        if (img.dataset.rawPosterUrl) return img.dataset.rawPosterUrl;

        let raw = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!raw || raw.startsWith('data:image/svg')) {
            raw = img.getAttribute('data-src') || '';
        }
        if (!raw) return '';

        // 如果已经被 ikanbot 原生代理重写过，从参数提取原 URL
        if (raw.includes('ikanbot.eu.org')) {
            try {
                const match = raw.match(/[?&](?:u|url)=([^&]+)/i);
                if (match && match[1]) {
                    let param = match[1];
                    if (param.startsWith('http') || param.includes('%3A') || param.includes('%3a')) {
                        return decodeURIComponent(param);
                    }
                    const decoded = decodeBase64Url(param);
                    if (decoded && decoded.startsWith('http')) {
                        return decoded;
                    }
                }
            } catch (e) {}
        }

        // 豆瓣图片地址
        if (raw.includes('doubanio.com')) {
            return raw;
        }

        // 其他合法的 http/https 图片地址 (排除已失效的 ikanbot.eu.org 代理和本地 403 占位图)
        if (raw.startsWith('http') && !raw.includes('ikanbot.eu.org') && !raw.includes('tv_default_medium.png')) {
            return raw;
        }

        return '';
    }

    // 2.5 生成优雅的 SVG 海报兜底图 (当豆瓣资源被删或网络彻底中断时，避免显示丑陋的裂图框)
    function escapeXml(unsafe) {
        return (unsafe || '').replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    function createFallbackPoster(title) {
        const cleanTitle = (title || '暂无海报').trim().slice(0, 14);
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
                <defs>
                    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stop-color="#1e293b"/>
                        <stop offset="100%" stop-color="#0f172a"/>
                    </linearGradient>
                </defs>
                <rect width="100%" height="100%" fill="url(#g)" rx="4"/>
                <g fill="#475569" transform="translate(110, 130)">
                    <rect width="80" height="60" rx="6" fill="#334155"/>
                    <circle cx="28" cy="22" r="10" fill="#64748b"/>
                    <path d="M12 50 L40 30 L68 50 Z" fill="#64748b"/>
                </g>
                <text x="150" y="240" fill="#f8fafc" font-size="15" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" text-anchor="middle" font-weight="600">${escapeXml(cleanTitle)}</text>
                <text x="150" y="270" fill="#94a3b8" font-size="12" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" text-anchor="middle">海报加载失败</text>
            </svg>
        `.trim();
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    // 2.6 海报加载调度器 (带内存缓存、请求去重与并发控制)
    const posterBlobCache = new Map();   // realUrl -> blobUrl
    const inFlightRequests = new Map();  // realUrl -> Promise<blobUrl>
    const pendingQueue = [];             // 待下载任务队列
    let activeConnections = 0;
    const MAX_CONCURRENT_DOWNLOADS = 6;  // 最大并发下载数

    function pumpQueue() {
        while (activeConnections < MAX_CONCURRENT_DOWNLOADS && pendingQueue.length > 0) {
            const task = pendingQueue.shift();
            activeConnections++;
            task().finally(() => {
                activeConnections--;
                pumpQueue();
            });
        }
    }

    function fetchPosterAsBlob(url) {
        if (posterBlobCache.has(url)) {
            return Promise.resolve(posterBlobCache.get(url));
        }
        if (inFlightRequests.has(url)) {
            return inFlightRequests.get(url);
        }

        const promise = new Promise((resolve, reject) => {
            pendingQueue.push(() => {
                return new Promise((taskDone) => {
                    // 使用 GM_xmlhttpRequest 突破跨域限制，并伪造豆瓣电影 Referer 头部解除 403/418 防盗链
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        headers: {
                            'Referer': 'https://movie.douban.com/',
                            'User-Agent': navigator.userAgent
                        },
                        responseType: 'blob',
                        timeout: 12000,
                        onload: function (res) {
                            if (res.status === 200 && res.response) {
                                try {
                                    const blobUrl = URL.createObjectURL(res.response);
                                    posterBlobCache.set(url, blobUrl);
                                    resolve(blobUrl);
                                } catch (err) {
                                    reject(err);
                                }
                            } else {
                                reject(new Error(`海报拉取响应异常: ${res.status}`));
                            }
                            taskDone();
                        },
                        onerror: function (err) {
                            reject(new Error('海报网络请求失败'));
                            taskDone();
                        },
                        ontimeout: function () {
                            reject(new Error('海报请求超时'));
                            taskDone();
                        }
                    });
                });
            });
            pumpQueue();
        });

        inFlightRequests.set(url, promise);
        promise.catch(() => {}).finally(() => {
            inFlightRequests.delete(url);
        });
        return promise;
    }

    // 修复单个 img 元素
    function fixSingleImage(img) {
        if (!img || img.dataset.ikbotFixed === 'true' || img.dataset.ikbotProcessing === 'true') {
            return;
        }

        const realUrl = extractRealImageUrl(img);
        if (!realUrl) return;

        img.dataset.rawPosterUrl = realUrl;
        img.dataset.ikbotProcessing = 'true';
        img.classList.add('ikbot-loading');

        fetchPosterAsBlob(realUrl)
            .then((blobUrl) => {
                img.src = blobUrl;
                img.dataset.ikbotFixed = 'true';
                img.classList.remove('ikbot-loading');
                img.classList.remove('lazy');
            })
            .catch((err) => {
                console.warn('[Ikanbot 增强] 修复海报失败:', realUrl, err.message);
                const title = img.getAttribute('alt') || img.getAttribute('title') || '';
                img.src = createFallbackPoster(title);
                img.dataset.ikbotFixed = 'true';
                img.classList.remove('ikbot-loading');
                img.classList.remove('lazy');
            })
            .finally(() => {
                img.dataset.ikbotProcessing = 'false';
            });
    }

    // 2.7 基于 IntersectionObserver 的视口懒加载
    let posterObserver = null;
    if (typeof IntersectionObserver !== 'undefined') {
        posterObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    observer.unobserve(img);
                    fixSingleImage(img);
                }
            });
        }, {
            rootMargin: '350px 0px' // 提前 350px 预加载，保证用户向下滚动时海报顺滑呈现
        });
    }

    function observeImage(img) {
        if (!img || img.dataset.ikbotFixed === 'true' || img.dataset.ikbotObserved === 'true') {
            return;
        }

        const realUrl = extractRealImageUrl(img);
        if (!realUrl) return;

        img.dataset.ikbotObserved = 'true';
        img.dataset.rawPosterUrl = realUrl;

        if (posterObserver) {
            posterObserver.observe(img);
        } else {
            fixSingleImage(img);
        }
    }

    // 2.8 扫描并监听 DOM 中的图片
    function scanImagesInContainer(container) {
        if (!container || !container.querySelectorAll) return;
        const imgs = container.querySelectorAll('img[data-src], img.lazy, img[src*="doubanio.com"], img[src*="ikanbot.eu.org"]');
        imgs.forEach(observeImage);
    }

    // 启动海报修复引擎
    function initPosterEngine() {
        injectPosterStyles();

        // 立即对已有 DOM 进行初次扫描
        scanImagesInContainer(document.body || document.documentElement);

        // 动态监听后续页面加载或翻页新增的图片
        const domObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) { // ELEMENT_NODE
                        if (node.tagName === 'IMG') {
                            observeImage(node);
                        } else {
                            scanImagesInContainer(node);
                        }
                    }
                }
            }
        });
        domObserver.observe(document.documentElement, { childList: true, subtree: true });

        // 双重保险：页面就绪和完全载入时再兜底扫描一次
        document.addEventListener('DOMContentLoaded', () => {
            scanImagesInContainer(document.body);
        });
        window.addEventListener('load', () => {
            scanImagesInContainer(document.body);
        });
    }

    // 立即启动海报修复引擎
    initPosterEngine();

    // ==========================================
    // 3. 播放页影视简介与评分类型逻辑 (等待 DOMContentLoaded 后执行)
    // ==========================================

    // 类型英文对应中文映射表
    const GENRE_MAP = {
        'comedy': '喜剧',
        'horror': '恐怖',
        'action': '动作',
        'sci-fi': '科幻',
        'science fiction': '科幻',
        'romance': '爱情',
        'drama': '剧情',
        'crime': '犯罪',
        'mystery': '悬疑',
        'fantasy': '奇幻',
        'animation': '动画',
        'documentary': '纪录片',
        'thriller': '惊悚',
        'war': '战争',
        'adventure': '冒险',
        'disaster': '灾难',
        'family': '家庭',
        'history': '历史',
        'biography': '传记',
        'music': '音乐',
        'musical': '歌舞',
        'sport': '运动',
        'western': '西部',
        'wuxia': '武侠',
        'costume': '古装',
        'short': '短片',
        'reality-tv': '真人秀',
        'talk-show': '脱口秀'
    };

    // 常见中文类型词集合
    const CHINESE_GENRES = new Set([
        '喜剧', '恐怖', '动作', '科幻', '爱情', '剧情', '犯罪', '悬疑',
        '奇幻', '动画', '纪录片', '惊悚', '战争', '冒险', '灾难', '家庭',
        '历史', '传记', '音乐', '歌舞', '运动', '西部', '武侠', '古装',
        '儿童', '短片', '真人秀', '脱口秀'
    ]);

    function initMovieInfoFeature() {
        // 缓存有效期：7 天 (7 * 24 * 60 * 60 * 1000 毫秒)
        const CACHE_EXPIRE_TIME = 7 * 24 * 60 * 60 * 1000;

        // 1. 获取当前影视的唯一标识 (ikanbot_id)
        const currentIdNode = document.getElementById('current_id');
        if (!currentIdNode) return;
        const ikanbotId = currentIdNode.value;
        if (!ikanbotId) return;

        // 2. 准备基础信息与缓存键
        const info = extractMovieInfo();
        const cacheKey = `ikanbot_movie_cache_${ikanbotId}`;

        // 3. 读取当前首选源索引 (0: NeoDB API, 1: WMDB API)
        let rawIndex = parseInt(localStorage.getItem('ikanbot_source_index') || '0', 10);
        let currentSourceIndex = isNaN(rawIndex) ? 0 : rawIndex % 2;

        // 4. 检查并读取缓存
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            renderUI(cachedData);
            return;
        }

        if (!info.title) {
            console.warn('[Ikanbot 增强] 未能提取到影视标题');
            return;
        }

        // 5. 初始化加载数据
        startLoad(false);

        // --- 数据拉取主入口 ---
        function startLoad(isManual) {
            fetchMovieData(info.title, info.year, isManual)
                .then(details => {
                    setCache(cacheKey, details);
                    renderUI(details);
                })
                .catch(err => {
                    console.error('[Ikanbot 增强] 数据源拉取失败:', err);
                    updateUIOnError(err.message || '数据源不可用');
                });
        }

        // 获取源名称提示
        function getSourceName(index) {
            if (index === 0) return '源: NeoDB';
            return '源: WMDB';
        }

        // --- 双源队列顺序调度逻辑 ---
        function fetchMovieData(title, year, isManual) {
            if (isManual) {
                // 手动指定源模式：只请求当前选中的单源，失败时不进行自动降级
                console.log(`[Ikanbot 增强] 手动控源模式，仅请求源 [${currentSourceIndex}]: ${getSourceName(currentSourceIndex)}`);
                renderUI({
                    rating: '加载中...',
                    votes: '',
                    genre: '加载中...',
                    summary: `正在拉取数据 (${getSourceName(currentSourceIndex)})...`,
                    isPlaceholder: true,
                    sourceIndex: currentSourceIndex,
                    sourceName: getSourceName(currentSourceIndex)
                });
                return requestSingleSource(currentSourceIndex, title, year);
            } else {
                // 首次自动进入模式：双源联合兜底，依次尝试直到成功
                return new Promise((resolve, reject) => {
                    const queueIndices = [currentSourceIndex, (currentSourceIndex + 1) % 2];
                    runQueue(queueIndices, 0, title, year, [], reject, resolve);
                });
            }
        }

        // 封装单个源的具体请求逻辑
        function requestSingleSource(index, title, year) {
            if (index === 0) {
                return fetchFromNeoDB(title).then(res => ({ ...res, sourceIndex: 0, sourceName: '源: NeoDB' }));
            } else {
                return fetchFromWmdbtv(title).then(res => ({ ...res, sourceIndex: 1, sourceName: '源: WMDB' }));
            }
        }

        function runQueue(queueIndices, index, title, year, errors, finalReject, finalResolve) {
            if (index >= queueIndices.length) {
                finalReject(new Error(errors.join('; ')));
                return;
            }
            const targetIdx = queueIndices[index];
            renderUI({
                rating: '加载中...',
                votes: '',
                genre: '加载中...',
                summary: `正在拉取数据 (${getSourceName(targetIdx)})...`,
                isPlaceholder: true,
                sourceIndex: targetIdx,
                sourceName: getSourceName(targetIdx)
            });

            requestSingleSource(targetIdx, title, year)
                .then(finalResolve)
                .catch(err => {
                    console.warn(`[Ikanbot 增强] 尝试数据源 [${targetIdx}] (${getSourceName(targetIdx)}) 失败:`, err.message);
                    errors.push(`${getSourceName(targetIdx)}: ${err.message}`);
                    runQueue(queueIndices, index + 1, title, year, errors, finalReject, finalResolve);
                });
        }

        // --- 接口 1: NeoDB API (联邦宇宙开源书影音 API) ---
        function fetchFromNeoDB(title) {
            return new Promise((resolve, reject) => {
                const apiUrl = `https://neodb.social/api/catalog/search?query=${encodeURIComponent(title)}&category=movie,tv`;
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: apiUrl,
                    headers: {
                        'User-Agent': navigator.userAgent
                    },
                    onload: function (response) {
                        if (response.status !== 200) {
                            reject(new Error(`NeoDB 接口状态码异常: ${response.status}`));
                            return;
                        }
                        try {
                            const data = JSON.parse(response.responseText);
                            const results = data.data;
                            if (!results || results.length === 0) {
                                reject(new Error('NeoDB 数据库无匹配结果'));
                                return;
                            }
                            const bestMatch = results[0];

                            // 解析影视类型
                            let genreList = [];
                            if (Array.isArray(bestMatch.genre)) {
                                bestMatch.genre.forEach(g => {
                                    const lower = String(g).toLowerCase().trim();
                                    if (GENRE_MAP[lower]) {
                                        genreList.push(GENRE_MAP[lower]);
                                    } else if (CHINESE_GENRES.has(g)) {
                                        genreList.push(g);
                                    }
                                });
                            }
                            if (Array.isArray(bestMatch.tags)) {
                                bestMatch.tags.forEach(t => {
                                    if (CHINESE_GENRES.has(t) && !genreList.includes(t)) {
                                        genreList.push(t);
                                    }
                                });
                            }

                            const genreText = genreList.length > 0 ? genreList.join(' / ') : '暂无类型';

                            resolve({
                                neodbUrl: bestMatch.id || '', // NeoDB 详情页链接
                                rating: bestMatch.rating ? `${bestMatch.rating}` : '暂无评分',
                                votes: bestMatch.rating_count ? `${bestMatch.rating_count}人评分` : '无评分人数',
                                genre: genreText,
                                summary: bestMatch.brief ? bestMatch.brief.trim() : '暂无简介。'
                            });
                        } catch (e) {
                            reject(new Error('NeoDB JSON 解析失败'));
                        }
                    },
                    onerror: function () {
                        reject(new Error('NeoDB 网络连接错误'));
                    }
                });
            });
        }

        // --- 接口 2: WMDB API ---
        function fetchFromWmdbtv(title) {
            return new Promise((resolve, reject) => {
                const apiUrl = `https://api.wmdb.tv/api/v1/movie/search?q=${encodeURIComponent(title)}`;
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: apiUrl,
                    headers: {
                        'User-Agent': navigator.userAgent
                    },
                    onload: function (response) {
                        if (response.status !== 200) {
                            if (response.responseText && response.responseText.includes('Too Many Search')) {
                                reject(new Error('WMDB 频控拦截：请求太快，请10秒后再试'));
                            } else {
                                reject(new Error(`WMDB API 状态码异常: ${response.status}`));
                            }
                            return;
                        }
                        try {
                            const res = JSON.parse(response.responseText);
                            if (res && res.data && res.data.length > 0) {
                                const d = res.data[0];

                                let summary = '暂无简介。';
                                if (d.data && d.data.length > 0 && d.data[0].description) {
                                    summary = d.data[0].description.trim();
                                }

                                let rating = '暂无评分';
                                let votes = '';
                                if (d.imdbRating && String(d.imdbRating).trim() !== '0' && String(d.imdbRating).trim() !== '') {
                                    rating = String(d.imdbRating);
                                    if (d.imdbVotes && Number(d.imdbVotes) > 0) {
                                        votes = `${d.imdbVotes}人评价 (IMDb)`;
                                    } else {
                                        votes = 'IMDb评分';
                                    }
                                } else if (d.doubanRating && String(d.doubanRating).trim() !== '0' && String(d.doubanRating).trim() !== '') {
                                    rating = String(d.doubanRating);
                                    if (d.doubanVotes && Number(d.doubanVotes) > 0) {
                                        votes = `${d.doubanVotes}人评价`;
                                    }
                                } else if (d.rottenRating && String(d.rottenRating).trim() !== '0' && String(d.rottenRating).trim() !== '') {
                                    rating = String(d.rottenRating);
                                    if (d.rottenVotes && Number(d.rottenVotes) > 0) {
                                        votes = `${d.rottenVotes}评价 (烂番茄)`;
                                    } else {
                                        votes = '烂番茄评分';
                                    }
                                }

                                // 提取类型
                                let rawGenre = (d.data && d.data.length > 0 && d.data[0].genre) || d.genre || '';
                                let genreText = '暂无类型';
                                if (rawGenre) {
                                    if (Array.isArray(rawGenre)) {
                                        genreText = rawGenre.join(' / ');
                                    } else {
                                        genreText = rawGenre.split(/[\/,]/).map(s => s.trim()).filter(Boolean).join(' / ');
                                    }
                                }

                                const defaultSearchUrl = `https://wmdb.tv/zh/search?q=${encodeURIComponent(title)}`;
                                const apiId = d.id || d._id || d.wmdbId;

                                if (apiId) {
                                    resolve({
                                        wmdbUrl: `https://wmdb.tv/zh/movies/${apiId}`,
                                        rating: rating,
                                        votes: votes,
                                        genre: genreText,
                                        summary: summary
                                    });
                                    return;
                                }

                                // 尝试通过 wmdb.tv 前端页面动态解析 24位 hex 详情页 ID
                                fetchWmdbWebDetailUrl(title)
                                    .then(webUrl => {
                                        resolve({
                                            wmdbUrl: webUrl || defaultSearchUrl,
                                            rating: rating,
                                            votes: votes,
                                            genre: genreText,
                                            summary: summary
                                        });
                                    })
                                    .catch(() => {
                                        resolve({
                                            wmdbUrl: defaultSearchUrl,
                                            rating: rating,
                                            votes: votes,
                                            genre: genreText,
                                            summary: summary
                                        });
                                    });
                            } else {
                                reject(new Error('WMDB 数据库无匹配结果'));
                            }
                        } catch (e) {
                            reject(new Error('WMDB JSON 解析失败'));
                        }
                    },
                    onerror: function () {
                        reject(new Error('WMDB 网络连接错误'));
                    }
                });
            });
        }

        // 辅助函数：请求 WMDB 前端搜索页提取详情页 24位 hex ID
        function fetchWmdbWebDetailUrl(title) {
            return new Promise((resolve) => {
                const searchPageUrl = `https://wmdb.tv/zh/search?q=${encodeURIComponent(title)}`;
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: searchPageUrl,
                    headers: {
                        'User-Agent': navigator.userAgent
                    },
                    onload: function (response) {
                        if (response.status === 200 && response.responseText) {
                            const match = response.responseText.match(/\/(?:zh\/)?movies\/([a-f0-9]{24})/i);
                            if (match && match[1]) {
                                resolve(`https://wmdb.tv/zh/movies/${match[1]}`);
                                return;
                            }
                        }
                        resolve(null);
                    },
                    onerror: function () {
                        resolve(null);
                    }
                });
            });
        }

        // --- 缓存管理函数 ---
        function getCache(key) {
            try {
                const itemStr = localStorage.getItem(key);
                if (!itemStr) return null;
                const item = JSON.parse(itemStr);
                const now = new Date().getTime();
                if (now > item.expiry) {
                    localStorage.removeItem(key);
                    return null;
                }
                return item.value;
            } catch (e) {
                return null;
            }
        }

        function setCache(key, value) {
            try {
                const now = new Date().getTime();
                const isDataEmpty = value.rating === '暂无评分' || value.summary === '暂无简介。';
                const expiryOffset = isDataEmpty ? 24 * 60 * 60 * 1000 : CACHE_EXPIRE_TIME;
                const item = {
                    value: value,
                    expiry: now + expiryOffset
                };
                localStorage.setItem(key, JSON.stringify(item));
            } catch (e) {
                console.warn('[Ikanbot 增强] 缓存写入失败', e);
            }
        }

        // 提取影片名称和上映年份
        function extractMovieInfo() {
            const titleNode = document.querySelector('#playList .detail h2.title');
            const title = titleNode ? (titleNode.innerText || titleNode.textContent || '').trim() : '';

            const metaNodes = Array.from(document.querySelectorAll('#playList .detail h3.meta'));
            let year = '';
            for (const node of metaNodes) {
                const text = (node.innerText || node.textContent || '').trim();
                if (/^\d{4}$/.test(text)) {
                    year = text;
                    break;
                }
            }
            return { title, year };
        }

        // 渲染 UI
        function renderUI(data) {
            let box = document.getElementById('movie-info-box');
            if (!box) {
                const rootContainer = document.querySelector('#playList .item-root');
                if (!rootContainer) return;
                box = document.createElement('div');
                box.id = 'movie-info-box';
                box.style.cssText = `
                    width: 100%;
                    margin-top: 10px;
                    border-top: 1px dashed #ddd;
                    padding: 12px 10px 8px 10px;
                    font-family: inherit;
                    box-sizing: border-box;
                `;
                rootContainer.appendChild(box);
            }

            // 直达对应源详情链接
            const activeSourceIndex = typeof data.sourceIndex === 'number' ? data.sourceIndex : currentSourceIndex;
            const isNeoDB = activeSourceIndex === 0;
            let displayLink = '';
            if (isNeoDB) {
                const neodbUrl = data.neodbUrl || `https://neodb.social/search/?q=${encodeURIComponent(info.title)}`;
                displayLink = `<a href="${neodbUrl}" target="_blank" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline;">直达NeoDB ↗</a>`;
            } else {
                const wmdbUrl = data.wmdbUrl || `https://wmdb.tv/zh/search?q=${encodeURIComponent(info.title)}`;
                displayLink = `<a href="${wmdbUrl}" target="_blank" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline;">直达WMDB ↗</a>`;
            }

            // 1. 只有当加载失败（isError === true）时，右上角才展示“重试 ↻”
            const retryLink = data.isError ? `<a id="movie-retry-btn" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline; margin-right: 12px; cursor: pointer;">重试 ↻</a>` : '';

            // 2. 只要不是加载中占位，就允许一键换源
            const switchLink = !data.isPlaceholder
                ? `<a id="movie-switch-btn" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline; margin-right: 12px; cursor: pointer;">换源 ⇄</a>`
                : '';

            box.innerHTML = `
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
                    <span style="color: #333;">影视增强 <span style="font-size: 11px; color: #888; font-weight: normal;">(${data.sourceName || '加载中'})</span></span>
                    <div style="display: flex; align-items: center;">
                        ${retryLink}
                        ${switchLink}
                        ${displayLink}
                    </div>
                </div>
                <div style="font-size: 13px; margin-bottom: 4px; color: #444;">
                    <span>评分：</span>
                    <strong id="movie-rating" style="color: #f09100; font-size: 16px; font-weight: bold;">${data.rating}</strong>
                    <span id="movie-votes" style="color: #888; font-size: 11px; margin-left: 6px;">${data.votes}</span>
                </div>
                <div style="font-size: 12px; margin-bottom: 8px; color: #555;">
                    <strong style="color: #333;">类型：</strong>
                    <span id="movie-genre" style="color: #333; font-weight: 500;">${data.genre || '暂无类型'}</span>
                </div>
                <div style="font-size: 12px; color: #555; line-height: 1.6;">
                    <strong style="color: #333;">影视简介：</strong>
                    <span id="movie-summary"></span>
                    <span id="summary-toggle" style="color: #00a1d6; cursor: pointer; margin-left: 6px; font-weight: bold; display: none; white-space: nowrap;">[展开]</span>
                </div>
            `;

            // 绑定重试事件
            if (data.isError) {
                const retryBtn = document.getElementById('movie-retry-btn');
                if (retryBtn) {
                    retryBtn.onclick = function () {
                        localStorage.removeItem(cacheKey);
                        startLoad(true);
                    };
                }
            }

            // 绑定一键换源事件
            if (!data.isPlaceholder) {
                const switchBtn = document.getElementById('movie-switch-btn');
                if (switchBtn) {
                    switchBtn.onclick = function () {
                        currentSourceIndex = (currentSourceIndex + 1) % 2;
                        localStorage.setItem('ikanbot_source_index', currentSourceIndex);
                        localStorage.removeItem(cacheKey);
                        startLoad(true);
                    };
                }
            }

            const summarySpan = document.getElementById('movie-summary');
            const toggleSpan = document.getElementById('summary-toggle');

            if (data.isPlaceholder) {
                summarySpan.innerText = data.summary;
                return;
            }

            const originalSummary = data.summary;
            const maxLen = 100;

            if (originalSummary.length > maxLen) {
                const shortSummary = originalSummary.substring(0, maxLen) + '...';
                summarySpan.innerText = shortSummary;
                toggleSpan.style.display = 'inline';

                let isExpanded = false;
                toggleSpan.addEventListener('click', function () {
                    if (isExpanded) {
                        summarySpan.innerText = shortSummary;
                        toggleSpan.innerText = '[展开]';
                    } else {
                        summarySpan.innerText = originalSummary;
                        toggleSpan.innerText = '[收起]';
                    }
                    isExpanded = !isExpanded;
                });
            } else {
                summarySpan.innerText = originalSummary;
                toggleSpan.style.display = 'none';
            }
        }

        // 处理加载错误时的 UI 更新
        function updateUIOnError(msg) {
            const errorData = {
                rating: '加载失败',
                votes: '',
                genre: '暂无类型',
                summary: `抱歉，数据拉取失败。错误详情: ${msg}`,
                isError: true,
                sourceIndex: currentSourceIndex,
                sourceName: '双源均未匹配'
            };
            renderUI(errorData);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMovieInfoFeature);
    } else {
        initMovieInfoFeature();
    }

})();
