// ==UserScript==
// @name         爱看机器人影视简介与豆瓣增强
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  为 ikanbot.com 播放页面添加影视简介、豆瓣评分及直达链接，采用 98dou API、豆瓣网页抓取、NeoDB 三源顺序联合兜底机制，支持多源一键切换、缓存与错误重试。
// @author       Antigravity
// @match        *://*.ikanbot.com/play/*
// @grant        GM_xmlhttpRequest
// @connect      api.98dou.cn
// @connect      movie.douban.com
// @connect      sec.douban.com
// @connect      neodb.social
// @require      https://cdnjs.cloudflare.com/ajax/libs/zepto/1.1.6/zepto.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 缓存有效期：7 天 (7 * 24 * 60 * 60 * 1000 毫秒)
    const CACHE_EXPIRE_TIME = 7 * 24 * 60 * 60 * 1000;

    // 1. 获取当前影视的唯一标识 (ikanbot_id)
    const currentIdNode = document.getElementById('current_id');
    if (!currentIdNode) return;
    const ikanbotId = currentIdNode.value;
    if (!ikanbotId) return;

    // 2. 准备基础信息与缓存键
    const info = extractMovieInfo();
    const cacheKey = `ikanbot_douban_cache_${ikanbotId}`;

    // 全局暂存已查出的豆瓣 ID，用于在加载失败时依然能渲染“直达豆瓣”链接
    let activeDoubanId = '';

    // 3. 读取当前首选源索引 (默认使用 2: NeoDB API，确保稳定性和免人机验证)
    let currentSourceIndex = parseInt(localStorage.getItem('ikanbot_source_index') || '2', 10);

    // 4. 检查并读取缓存
    const cachedData = getCache(cacheKey);
    if (cachedData) {
        if (cachedData.doubanId) {
            activeDoubanId = cachedData.doubanId;
        }
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
            doubanId: '',
            rating: '加载中...',
            votes: '',
            summary: '正在加载影视评分及简介...',
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
        if (index === 0) return '源: 98dou';
        if (index === 1) return '源: 豆瓣';
        return '源: NeoDB';
    }

    // --- 三源队列顺序调度逻辑 ---
    function fetchMovieData(title, year, isManual) {
        if (isManual) {
            // 手动指定源模式：只请求当前选中的单源，失败时不进行自动降级
            console.log(`[Ikanbot 增强] 手动控源模式，仅请求源 [${currentSourceIndex}]: ${getSourceName(currentSourceIndex)}`);
            return requestSingleSource(currentSourceIndex, title, year);
        } else {
            // 首次自动进入模式：三源联合兜底，依次尝试直到成功
            return new Promise((resolve, reject) => {
                const queue = [];
                for (let i = 0; i < 3; i++) {
                    const idx = (currentSourceIndex + i) % 3;
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
            return fetchFrom98Dou(title, year).then(res => ({ ...res, sourceName: '源: 98dou' }));
        } else if (index === 1) {
            return searchDouban(title, year)
                .then(id => {
                    if (!id) throw new Error('未在豆瓣找到记录');
                    activeDoubanId = id; // 暂存成功的豆瓣 ID
                    return fetchDoubanDetail(id);
                })
                .then(res => ({ ...res, sourceName: '源: 豆瓣' }));
        } else {
            return fetchFromNeoDB(title).then(res => ({ ...res, sourceName: '源: NeoDB' }));
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

    // --- 接口 1: 主源 98dou API ---
    function fetchFrom98Dou(title, year) {
        return new Promise((resolve, reject) => {
            const apiUrl = `https://api.98dou.cn/api/douban/info?url=${encodeURIComponent(title)}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'User-Agent': navigator.userAgent
                },
                onload: function(response) {
                    if (response.status !== 200) {
                        reject(new Error(`API 状态码异常: ${response.status}`));
                        return;
                    }
                    try {
                        const res = JSON.parse(response.responseText);
                        if (res.code === 1 && res.data) {
                            const d = res.data;
                            if (d.vod_douban_id) {
                                activeDoubanId = d.vod_douban_id; // 暂存成功的豆瓣 ID
                            }
                            resolve({
                                doubanId: d.vod_douban_id || '',
                                rating: d.vod_douban_score && d.vod_douban_score !== '0' ? d.vod_douban_score : '暂无评分',
                                votes: d.vod_score_num ? `${d.vod_score_num}人评价` : '',
                                summary: d.vod_content ? d.vod_content.trim() : '暂无简介。'
                            });
                        } else {
                            reject(new Error(res.msg || 'API 内部获取失败'));
                        }
                    } catch (e) {
                        reject(new Error('JSON 解析失败'));
                    }
                },
                onerror: function() {
                    reject(new Error('网络连接错误'));
                }
            });
        });
    }

    // --- 接口 2: 备用源 1 (豆瓣联想 + 网页抓取) ---
    function searchDouban(title, year) {
        return new Promise((resolve, reject) => {
            const searchUrl = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: searchUrl,
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Referer': 'https://movie.douban.com/'
                },
                onload: function(response) {
                    if (response.status !== 200) {
                        reject(new Error(`联想接口错误 (状态码: ${response.status})`));
                        return;
                    }
                    try {
                        const results = JSON.parse(response.responseText);
                        if (!results || results.length === 0) {
                            resolve(null);
                            return;
                        }
                        let bestMatch = results[0];
                        if (year) {
                            const matchedYear = results.find(item => item.year === String(year));
                            if (matchedYear) {
                                bestMatch = matchedYear;
                            }
                        }
                        resolve(bestMatch.id);
                    } catch (e) {
                        reject(new Error('解析联想 JSON 失败'));
                    }
                },
                onerror: function() {
                    reject(new Error('联想网络错误'));
                }
            });
        });
    }

    // 网页抓取详情页
    function fetchDoubanDetail(doubanId) {
        return new Promise((resolve, reject) => {
            const detailUrl = `https://movie.douban.com/subject/${doubanId}/`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: detailUrl,
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Referer': 'https://movie.douban.com/'
                },
                onload: function(response) {
                    const htmlText = response.responseText || '';
                    const finalUrl = response.finalUrl || '';

                    const isVerifyPage = htmlText.includes('sec.douban.com') || 
                                         finalUrl.includes('sec.douban.com') ||
                                         htmlText.includes('chk(e)') ||
                                         htmlText.includes('tok');

                    if (isVerifyPage) {
                        reject(new Error('NEED_VERIFY'));
                        return;
                    }

                    if (response.status !== 200) {
                        reject(new Error(`详情页状态码异常: ${response.status}`));
                        return;
                    }

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    const ratingNode = doc.querySelector('.ll.rating_num');
                    const rating = ratingNode ? ratingNode.innerText.trim() : '暂无评分';
                    const votesNode = doc.querySelector('.rating_people span');
                    const votes = votesNode ? votesNode.innerText.trim() : '';

                    let summaryNode = doc.querySelector('#link-report-intra .all, #link-report .all');
                    if (!summaryNode) {
                        summaryNode = doc.querySelector('#link-report-intra span, #link-report span');
                    }
                    let summary = '';
                    if (summaryNode) {
                        summary = summaryNode.innerText
                            .replace(/\s*\n\s*/g, '\n')
                            .trim();
                    } else {
                        summary = '暂无简介。';
                    }

                    resolve({
                        doubanId,
                        rating,
                        votes,
                        summary
                    });
                },
                onerror: function() {
                    reject(new Error('抓取网页网络错误'));
                }
            });
        });
    }

    // --- 接口 3: 备用源 2 (NeoDB 联邦宇宙开源书影音 API) ---
    function fetchFromNeoDB(title) {
        return new Promise((resolve, reject) => {
            const apiUrl = `https://neodb.social/api/catalog/search?query=${encodeURIComponent(title)}&category=movie`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'User-Agent': navigator.userAgent
                },
                onload: function(response) {
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
                        
                        let doubanId = '';
                        if (bestMatch.external_resources) {
                            const dbLink = bestMatch.external_resources.find(res => res.url && res.url.includes('douban.com/subject/'));
                            if (dbLink) {
                                const m = dbLink.url.match(/subject\/(\d+)/);
                                if (m) doubanId = m[1];
                            }
                        }

                        if (doubanId) {
                            activeDoubanId = doubanId; // 暂存成功的豆瓣 ID
                        }

                        resolve({
                            doubanId: doubanId,
                            neodbUrl: bestMatch.id || '', // 暂存 NeoDB 详情页链接
                            rating: bestMatch.rating ? `${bestMatch.rating}` : '暂无评分',
                            votes: bestMatch.rating_count ? `${bestMatch.rating_count}人评分` : '无评分人数',
                            summary: bestMatch.brief ? bestMatch.brief.trim() : '暂无简介。'
                        });
                    } catch (e) {
                        reject(new Error('NeoDB JSON 解析失败'));
                    }
                },
                onerror: function() {
                    reject(new Error('NeoDB 网络连接错误'));
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
        let box = document.getElementById('douban-info-box');
        if (!box) {
            const rootContainer = document.querySelector('#playList .item-root');
            if (!rootContainer) return;
            box = document.createElement('div');
            box.id = 'douban-info-box';
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

        // 统一“直达对应源详情”逻辑：不同源展示不同的按钮文案和链接路径
        const isNeoDB = data.sourceName && data.sourceName.includes('NeoDB');
        let displayLink = '';
        if (isNeoDB) {
            // NeoDB 源：直达 NeoDB 页面，如果无 ID 则跳转 NeoDB 主页
            const neodbUrl = data.neodbUrl || `https://neodb.social/`;
            displayLink = `<a href="${neodbUrl}" target="_blank" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline;">直达NeoDB ↗</a>`;
        } else {
            // 豆瓣及 98dou 源：直达豆瓣主页，如果无 ID 则通过豆瓣搜索兜底
            const currentDbId = data.doubanId || activeDoubanId;
            const doubanUrl = currentDbId 
                ? `https://movie.douban.com/subject/${currentDbId}/` 
                : `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(info.title)}`;
            displayLink = `<a href="${doubanUrl}" target="_blank" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline;">直达豆瓣 ↗</a>`;
        }
        
        // 1. 只有当加载失败（isError === true）时，右上角才展示“重试 ↻”
        const retryLink = data.isError ? `<a id="douban-retry-btn" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline; margin-right: 12px; cursor: pointer;">重试 ↻</a>` : '';
        
        // 2. 只要不是加载中占位，就允许一键换源（即使加载失败了，也能允许点击换源）
        const switchLink = !data.isPlaceholder 
            ? `<a id="douban-switch-btn" style="color: #00a1d6; font-size: 12px; font-weight: normal; text-decoration: underline; margin-right: 12px; cursor: pointer;">换源 ⇄</a>` 
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
            <div style="font-size: 13px; margin-bottom: 8px; color: #444;">
                <span>评分：</span>
                <strong id="douban-rating" style="color: #f09100; font-size: 16px; font-weight: bold;">${data.rating}</strong>
                <span id="douban-votes" style="color: #888; font-size: 11px; margin-left: 6px;">${data.votes}</span>
            </div>
            <div style="font-size: 12px; color: #555; line-height: 1.6;">
                <strong style="color: #333;">影视简介：</strong>
                <span id="douban-summary"></span>
                <span id="summary-toggle" style="color: #00a1d6; cursor: pointer; margin-left: 6px; font-weight: bold; display: none; white-space: nowrap;">[展开]</span>
            </div>
        `;

        // 仅在错误状态渲染后，绑定重试事件
        if (data.isError) {
            const retryBtn = document.getElementById('douban-retry-btn');
            if (retryBtn) {
                retryBtn.onclick = function() {
                    localStorage.removeItem(cacheKey);
                    startLoad(true);
                };
            }
        }

        // 绑定一键换源事件
        if (!data.isPlaceholder) {
            const switchBtn = document.getElementById('douban-switch-btn');
            if (switchBtn) {
                switchBtn.onclick = function() {
                    currentSourceIndex = (currentSourceIndex + 1) % 3;
                    localStorage.setItem('ikanbot_source_index', currentSourceIndex);
                    localStorage.removeItem(cacheKey);
                    startLoad(true);
                };
            }
        }

        const summarySpan = document.getElementById('douban-summary');
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
            toggleSpan.addEventListener('click', function() {
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
            doubanId: '',
            rating: '加载失败',
            votes: '',
            summary: msg.includes('NEED_VERIFY')
                ? '因豆瓣安全策略限制，网页抓取已被阻拦。请点击右上方“直达豆瓣”链接进行一次滑块验证，完成后点击旁边的“重试 ↻”即可。'
                : `抱歉，该源拉取失败。错误详情: ${msg}`,
            isError: true,
            sourceName: getSourceName(currentSourceIndex)
        };
        renderUI(errorData);
    }

})();
