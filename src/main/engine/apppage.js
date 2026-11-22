'use strict';
/**
 * 启动器自己的页面（2.0.0-pre8）。窗口只能停留在这一页，接口也只回答这一页发来的调用。
 * 这是底层，不知道任何功能。
 */
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = pathToFileURL(path.join(__dirname, '..', '..', 'renderer', 'index.html')).href;
const clean = (u) => decodeURI(String(u).split(/[?#]/)[0]).toLowerCase();
const WANT = clean(PAGE);

function isAppPage(url) {
  try { return clean(url) === WANT; } catch { return false; }
}

module.exports = { isAppPage };
