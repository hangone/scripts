// ==UserScript==
// @name         绕过希冀考试客户端检测
// @version      1.0
// @description  拦截 localhost:8087 的 GetAdapterInfo 和 GetDeviceInfo 请求，模拟考试客户端返回数据 (ES6优化版)
// @match        *://course.educg.net/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/*
 * 工作原理：
 * 1. 拦截底层 XHR / fetch 请求，全面覆盖接口。
 * 2. swToken 从 URL 提取并持久化，解决考试子页面丢失 URL 参数的重定向循环。
 * 3. 动态生成的设备标识（MAC, IP, PID等）通过 GM_setValue 持久化，保持跨考试/页面一致。
 * 4. 采用轻量化原生 UI，通过 Tampermonkey 菜单「设置」唤出，不侵入页面结构。
 */

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const store = (k, v) => GM_setValue(k, v);
    const load = (k, fallback) => GM_getValue(k, fallback);

    // ======================== 设备标识生成 ========================

    const OUI_LIST = ['28-6F-B9', 'F8-A2-D6', 'C8-5B-76', '3C-22-FB', 'A4-4C-C8', 'DC-A6-32', '98-FA-9B', 'AC-67-5D', 'E8-48-B8', '1C-B7-2C', '70-85-C2'];
    const WIN_BUILDS = [19045, 22000, 22621, 22631];

    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[rand(0, 15)]).join('');

    const genMAC = () => `${OUI_LIST[rand(0, OUI_LIST.length - 1)]}-${hex(2)}-${hex(2)}-${hex(2)}`;
    const genIP = () => `10.${rand(10, 233)}.${rand(1, 254)}.${rand(1, 254)}`;
    const calcGateway = ip => ip.replace(/\.\d+$/, '.1');
    const genHostName = () => `DESKTOP-${hex(7)}`;
    const genInstanceId = (pid, tick) => pid.toString(16).padStart(8, '0').toUpperCase() + tick.toString(16).padStart(8, '0').toUpperCase();

    const genIdentity = () => {
        const ip = genIP();
        return {
            MacAddr: genMAC(), RealIP: ip, GateWay: calcGateway(ip),
            PID: rand(100, 65535), TickCount: rand(3600000, 255600000),
            HostName: genHostName(), OSMajor: 10, OSMinor: 0,
            Build: WIN_BUILDS[rand(0, WIN_BUILDS.length - 1)], MemoryMB: [8192, 16384, 32768][rand(0, 2)]
        };
    };

    const getIdentity = () => {
        const defaultId = genIdentity();
        const storedId = load('id', {});
        // 自动合并补全缺失字段
        const merged = { ...defaultId, ...storedId };
        if (Object.keys(storedId).length < Object.keys(defaultId).length) store('id', merged);
        return merged;
    };

    const getSwToken = () => {
        const token = new URLSearchParams(location.search).get('swToken');
        if (token) store('swToken', token);
        return token || load('swToken', '');
    };

    // ======================== 请求拦截核心 ========================

    const tryMock = url => {
        if (!url) return null;
        const d = getIdentity();
        if (url.includes('localhost:8087/GetAdapterInfo')) {
            return { MacAddr: d.MacAddr, RealIP: d.RealIP, GateWay: d.GateWay, ExamId: getSwToken(), InstanceId: genInstanceId(d.PID, d.TickCount) };
        }
        if (url.includes('localhost:8087/GetDeviceInfo')) {
            return { HostName: d.HostName, OSMajor: d.OSMajor, OSMinor: d.OSMinor, Build: d.Build, MemoryMB: d.MemoryMB };
        }
        return null;
    };

    // --- 1. XHR 拦截 ---
    const { open: origOpen, send: origSend } = win.XMLHttpRequest.prototype;
    win.XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this._mockUrl = url;
        return origOpen.call(this, method, url, ...args);
    };
    win.XMLHttpRequest.prototype.send = function (...args) {
        const data = tryMock(this._mockUrl);
        if (data) {
            const json = JSON.stringify(data);
            Object.defineProperties(this, {
                readyState: { get: () => 4 }, status: { get: () => 200 }, statusText: { get: () => 'OK' },
                responseText: { get: () => json }, response: { get: () => json }
            });
            this.getResponseHeader = n => n.toLowerCase() === 'content-type' ? 'application/json' : null;
            this.getAllResponseHeaders = () => 'content-type: application/json';
            setTimeout(() => {
                this.onreadystatechange?.(); this.onload?.();
                this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new Event('load'));
            }, 0);
            return;
        }
        return origSend.apply(this, args);
    };

    // --- 2. Fetch 拦截 (现代浏览器补充) ---
    const origFetch = win.fetch;
    if (origFetch) {
        win.fetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            const data = tryMock(url);
            if (data) {
                return Promise.resolve(new Response(JSON.stringify(data), {
                    status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }
                }));
            }
            return origFetch.apply(this, args);
        };
    }

    // ======================== WebRTC 本机 IP 检测 ========================

    let detectedIP = '';
    const detectLocalIP = async (callback) => {
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.onicecandidate = e => {
                const ip = e.candidate?.candidate?.match(/(\d{1,3}\.){3}\d{1,3}/)?.[0];
                if (ip && ip !== '0.0.0.0') detectedIP = ip;
                pc.close();
                if (callback) callback(detectedIP);
            };
            pc.createDataChannel('');
            await pc.setLocalDescription(await pc.createOffer());
        } catch (e) { callback?.(''); }
    };
    detectLocalIP();

    // ======================== 设置面板 UI ========================

    let panelBuilt = false;

    const buildAndShowUI = () => {
        if (!panelBuilt) {
            panelBuilt = true;
            const html = `
                <style>
                    #mcg-wrap { font: 14px/1.5 -apple-system, sans-serif; color: #333; }
                    #mcg-overlay { position: fixed; inset: 0; z-index: 99998; background: rgba(0,0,0,.35); opacity: 0; pointer-events: none; transition: opacity .2s; }
                    #mcg-panel { position: fixed; top: 50%; left: 50%; z-index: 99999; transform: translate(-50%, -50%) scale(.92); width: 480px; max-width: 94vw; background: #fff; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.25); opacity: 0; pointer-events: none; transition: all .2s; }
                    #mcg-wrap.on #mcg-overlay { opacity: 1; pointer-events: auto; }
                    #mcg-wrap.on #mcg-panel { opacity: 1; transform: translate(-50%, -50%) scale(1); pointer-events: auto; }
                    .mcg-hd { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eee; }
                    .mcg-hd h3 { margin: 0; font-size: 15px; }
                    .mcg-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #999; }
                    .mcg-bd { padding: 14px 18px; max-height: 68vh; overflow-y: auto; }
                    .mcg-sec { font-size: 11px; font-weight: 600; color: #4a90d9; text-transform: uppercase; margin: 14px 0 6px; border-bottom: 1px solid #eee; }
                    .mcg-sec:first-child { margin-top: 0; }
                    .mcg-field { margin-bottom: 10px; flex: 1; }
                    .mcg-field label { display: block; font-size: 11px; font-weight: 500; color: #888; margin-bottom: 2px; }
                    .mcg-field .mcg-desc { font-size: 10px; color: #bbb; }
                    .mcg-field input { width: 100%; padding: 6px 8px; border: 1px solid #ddd; border-radius: 5px; font: 13px/1.4 monospace; box-sizing: border-box; }
                    .mcg-field input:focus { outline: none; border-color: #4a90d9; }
                    .mcg-field input[readonly] { background: #f5f5f5; color: #aaa; }
                    .mcg-row, .mcg-iprow { display: flex; gap: 8px; }
                    .mcg-iprow button { padding: 0 10px; border: 1px solid #ddd; border-radius: 5px; background: #f8f8f8; cursor: pointer; white-space: nowrap; }
                    .mcg-ft { display: flex; gap: 6px; padding: 12px 18px; border-top: 1px solid #eee; justify-content: flex-end; }
                    .mcg-btn { padding: 7px 16px; border: none; border-radius: 5px; font-size: 13px; cursor: pointer; }
                    .mcg-btn:active { transform: scale(.97); }
                    .mcg-btn-cancel { background: #f0f0f0; color: #555; }
                    .mcg-btn-reset { background: #fff0f0; color: #d44; }
                    .mcg-btn-save { background: #4a90d9; color: #fff; }
                    #mcg-toast { position: fixed; bottom: 24px; right: 18px; z-index: 100000; background: #333; color: #fff; padding: 8px 14px; border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
                    #mcg-toast.on { opacity: 1; }
                </style>
                <div id="mcg-wrap">
                    <div id="mcg-overlay"></div>
                    <div id="mcg-panel">
                        <div class="mcg-hd"><h3>希冀考试 Mock 设置</h3><button class="mcg-close" id="mcg-close">&times;</button></div>
                        <div class="mcg-bd">
                            <div class="mcg-sec">GetAdapterInfo</div>
                            <div class="mcg-field"><label>ExamId (Token)</label><input id="mcg-examId" readonly><div class="mcg-desc">URL自动获取并持久化</div></div>
                            <div class="mcg-field"><label>MacAddr</label><input id="mcg-mac"></div>
                            <div class="mcg-field"><label>RealIP</label><div class="mcg-iprow"><input id="mcg-ip"><button id="mcg-detect">检测本机</button></div></div>
                            <div class="mcg-field"><label>GateWay</label><input id="mcg-gw"></div>
                            <div class="mcg-row">
                                <div class="mcg-field"><label>PID</label><input id="mcg-pid" type="number"></div>
                                <div class="mcg-field"><label>TickCount</label><input id="mcg-tick" type="number"></div>
                            </div>
                            <div class="mcg-field"><label>InstanceId</label><input id="mcg-iid" readonly><div class="mcg-desc">PID + TickCount 生成</div></div>
                            <div class="mcg-sec">GetDeviceInfo</div>
                            <div class="mcg-field"><label>HostName</label><input id="mcg-host"></div>
                            <div class="mcg-row">
                                <div class="mcg-field"><label>OS Major</label><input id="mcg-osMajor" type="number"></div>
                                <div class="mcg-field"><label>OS Minor</label><input id="mcg-osMinor" type="number"></div>
                                <div class="mcg-field"><label>Build</label><input id="mcg-build" type="number"></div>
                                <div class="mcg-field"><label>Memory</label><input id="mcg-mem" type="number"></div>
                            </div>
                        </div>
                        <div class="mcg-ft">
                            <button class="mcg-btn mcg-btn-reset" id="mcg-reset">重新生成</button>
                            <button class="mcg-btn mcg-btn-cancel" id="mcg-cancel">取消</button>
                            <button class="mcg-btn mcg-btn-save" id="mcg-save">保存</button>
                        </div>
                    </div>
                </div>
                <div id="mcg-toast"></div>
            `;
            document.body.insertAdjacentHTML('beforeend', html);

            const $ = id => document.getElementById(id);
            const showToast = msg => { $('mcg-toast').textContent = msg; $('mcg-toast').classList.add('on'); setTimeout(() => $('mcg-toast').classList.remove('on'), 1800); };
            const closePanel = () => $('mcg-wrap').classList.remove('on');

            win._mcgOpen = () => {
                const d = getIdentity();
                $('mcg-examId').value = getSwToken();
                ['mac','ip','gw','pid','tick','host','osMajor','osMinor','build','mem'].forEach(k => {
                    $(`mcg-${k}`).value = d[{mac:'MacAddr',ip:'RealIP',gw:'GateWay',pid:'PID',tick:'TickCount',host:'HostName',osMajor:'OSMajor',osMinor:'OSMinor',build:'Build',mem:'MemoryMB'}[k]];
                });
                $('mcg-iid').value = genInstanceId(d.PID, d.TickCount);
                $('mcg-wrap').classList.add('on');
            };

            $('mcg-overlay').onclick = $('mcg-close').onclick = $('mcg-cancel').onclick = closePanel;
            document.addEventListener('keydown', e => e.key === 'Escape' && closePanel());

            $('mcg-pid').oninput = $('mcg-tick').oninput = () => {
                $('mcg-iid').value = genInstanceId(parseInt($('mcg-pid').value) || 0, parseInt($('mcg-tick').value) || 0);
            };

            $('mcg-detect').onclick = function () {
                this.textContent = '...'; this.disabled = true;
                detectLocalIP(ip => {
                    if (ip) { $('mcg-ip').value = ip; $('mcg-gw').value = calcGateway(ip); showToast(`IP: ${ip}`); }
                    else showToast('未检测到');
                    this.textContent = '检测本机'; this.disabled = false;
                });
            };

            $('mcg-save').onclick = () => {
                const [pid, tick] = [parseInt($('mcg-pid').value), parseInt($('mcg-tick').value)];
                if (!pid || pid < 4 || pid > 4194303) return showToast('PID: 4 ~ 4194303');
                if (isNaN(tick) || tick < 0 || tick > 4294967295) return showToast('TickCount: 0 ~ 4294967295');

                store('id', {
                    MacAddr: $('mcg-mac').value.trim().toUpperCase(), RealIP: $('mcg-ip').value.trim(), GateWay: $('mcg-gw').value.trim(),
                    PID: pid, TickCount: tick, HostName: $('mcg-host').value.trim() || genHostName(),
                    OSMajor: parseInt($('mcg-osMajor').value) || 10, OSMinor: parseInt($('mcg-osMinor').value) || 0,
                    Build: parseInt($('mcg-build').value) || 19045, MemoryMB: parseInt($('mcg-mem').value) || 16384
                });
                closePanel(); showToast('已保存');
            };

            $('mcg-reset').onclick = () => { store('id', genIdentity()); win._mcgOpen(); showToast('已重新生成'); };
        }
        win._mcgOpen();
    };

    // ======================== 注册菜单 ========================

    GM_registerMenuCommand('设置', () => {
        document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', buildAndShowUI) : buildAndShowUI();
    });

})();
