// ==UserScript==
// @name         NCU成绩解锁
// @namespace    ncu_jwpt
// @version      1.4
// @description  点击成绩查看平时分
// @match        *://jwpt.ncu.edu.cn/jsxsd/kscj/cjcx_frm*
// @updateURL    https://github.com/hangone/scripts/raw/refs/heads/main/ncu_jwpt.user.js
// @downloadURL  https://github.com/hangone/scripts/raw/refs/heads/main/ncu_jwpt.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    let h = false;
    const f = () => {
        if (h || !window.layui?.table) return;
        const t = window.layui.table, r = t.render;
        t.render = function(c) {
            if (c.id === 'cjcx_table' || c.elem === '#cjcx_table') {
                c.cols[0].forEach(o => {
                    if (o.field === 'zcjstr') {
                        o.templet = d => {
                            const s = d.zcjstr || "", v = parseFloat(d.zcj), 
                                  color = (v < 60 || d.zcj === '1') ? 'red' : '#0066cc';
                            return `<a style="color:${color};text-decoration:underline;cursor:pointer;font-weight:bold" onclick="ckcj('${d.xs0101id}','${d.jx0404id}','${d.cj0708id}','${d.zcjstr}')">${s}</a>`;
                        };
                    } else if (o.field === 'jd') {
                        o.templet = d => d.jd ?? '0.0';
                    }
                });
            }
            return r.call(this, c);
        };
        h = true;
    };
    const s = Date.now(), i = setInterval(() => {
        if (h || Date.now() - s > 3000) return clearInterval(i);
        f();
    }, 100);
    document.addEventListener('DOMContentLoaded', f);
})();
