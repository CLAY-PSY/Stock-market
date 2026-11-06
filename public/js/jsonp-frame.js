// 运行在 jsonp-frame.html（sandbox iframe）中的普通脚本：按主页面的请求加载行情脚本，读取全局变量后传回。
(function () {
  'use strict';

  // 只允许加载这两个行情域名下的脚本
  var ALLOWED_PREFIXES = ['https://stock.gtimg.cn/', 'https://smartbox.gtimg.cn/'];
  var NAME_RE = /^v_[A-Za-z0-9_.]{1,64}$/;

  function reply(message) {
    // sandbox 下本页面是不透明源，无法得知父页面的源，只能用 '*'；内容是公开行情数据
    window.parent.postMessage(message, '*');
  }

  function clearGlobal(name) {
    try {
      delete window[name];
    } catch (e) {
      window[name] = undefined;
    }
  }

  function detach(el) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /** 只传回 JSON 能表达的纯数据（字符串 / 数字 / 数组 / 对象） */
  function plain(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch (e) {
      return null;
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var req = event.data;
    if (!req || typeof req.id !== 'number' || typeof req.url !== 'string' || typeof req.name !== 'string') return;
    var allowed = ALLOWED_PREFIXES.some(function (prefix) {
      return req.url.indexOf(prefix) === 0;
    });
    if (!allowed || !NAME_RE.test(req.name)) {
      reply({ id: req.id, ok: false });
      return;
    }
    clearGlobal(req.name);
    var el = document.createElement('script');
    el.async = true;
    el.referrerPolicy = 'no-referrer';
    el.onload = function () {
      var value = plain(window[req.name]);
      clearGlobal(req.name);
      detach(el);
      reply({ id: req.id, ok: true, value: value });
    };
    el.onerror = function () {
      detach(el);
      reply({ id: req.id, ok: false });
    };
    el.src = req.url;
    document.head.appendChild(el);
  });

  reply({ ready: true });
})();
