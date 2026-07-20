// ==UserScript==
// @name         爱看机器人-影视简介
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  为 ikanbot.com 播放页面添加影视简介、评分及类型展示，采用 NeoDB API 与 WMDB API 双源顺序联合兜底机制，支持多源一键切换、缓存与错误重试。
// @author       Antigravity
// @match        *://*.ikanbot.com/play/*
// @grant        GM_xmlhttpRequest
// @connect      neodb.social
// @connect      api.wmdb.tv
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
            // 允许放行的域名白名单：当前站、NeoDB、WMDB
            const allowedDomains = ['ikanbot.com', 'neodb.social', 'wmdb.tv'];
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
    // 2. 影视简介与评分类型逻辑 (等待 DOMContentLoaded 后执行)
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
            const placeholderData = {
                rating: '加载中...',
                votes: '',
                genre: '加载中...',
                summary: '正在加载影视评分、类型及简介...',
                isPlaceholder: true,
                sourceName: getSourceName(currentSourceIndex)
            };
            renderUI(placeholderData);

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
                return requestSingleSource(currentSourceIndex, title, year);
            } else {
                // 首次自动进入模式：双源联合兜底，依次尝试直到成功
                return new Promise((resolve, reject) => {
                    const queue = [];
                    for (let i = 0; i < 2; i++) {
                        const idx = (currentSourceIndex + i) % 2;
                        queue.push(() => requestSingleSource(idx, title, year));
                    }
                    // 递归依次尝试，直到有一个成功，否则抛出汇总错误
                    runQueue(queue, 0, [], reject, resolve);
                });
            }
        }

        // 封装单个源的具体请求逻辑
        function requestSingleSource(index, title, year) {
            if (index === 0) {
                return fetchFromNeoDB(title).then(res => ({ ...res, sourceName: '源: NeoDB' }));
            } else {
                return fetchFromWmdbtv(title).then(res => ({ ...res, sourceName: '源: WMDB' }));
            }
        }

        function runQueue(queue, index, errors, finalReject, finalResolve) {
            if (index >= queue.length) {
                finalReject(new Error(errors.join('; ')));
                return;
            }
            queue[index]()
                .then(finalResolve)
                .catch(err => {
                    console.warn(`[Ikanbot 增强] 尝试数据源 [${index}] 失败:`, err.message);
                    errors.push(err.message);
                    runQueue(queue, index + 1, errors, finalReject, finalResolve);
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
                                neodbUrl: bestMatch.id || '', // NeoDB 详情页链接 (如 https://neodb.social/movie/xxxx)
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
                                if (d.doubanRating && d.doubanRating !== '0') {
                                    rating = d.doubanRating;
                                }

                                let votes = '';
                                if (d.doubanVotes) {
                                    votes = `${d.doubanVotes}人评价`;
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

                                resolve({
                                    rating: rating,
                                    votes: votes,
                                    genre: genreText,
                                    summary: summary
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
            const title = titleNode ? titleNode.innerText.trim() : '';

            const metaNodes = Array.from(document.querySelectorAll('#playList .detail h3.meta'));
            let year = '';
            for (const node of metaNodes) {
                const text = node.innerText.trim();
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
            const isNeoDB = currentSourceIndex === 0;
            let displayLink = '';
            if (isNeoDB) {
                const neodbUrl = data.neodbUrl || `https://neodb.social/search/?q=${encodeURIComponent(info.title)}`;
                displayLink = `<a href="${neodbUrl}" target="_blank" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline;">直达NeoDB ↗</a>`;
            } else {
                const wmdbUrl = `https://wmdb.tv/movie/search?q=${encodeURIComponent(info.title)}`;
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
                summary: `抱歉，该源拉取失败。错误详情: ${msg}`,
                isError: true,
                sourceName: getSourceName(currentSourceIndex)
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
