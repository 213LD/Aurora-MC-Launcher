'use strict';
/**
 * 启动器有哪些页面，测试脚本都从这里拿（rc9）。
 * 以前按钮走查、截图基线、体验、挂机、「每个页面进一遍」各写了一份页面清单，rc4 加了日志中心以后五份都没补，
 * 这些测试从来不进日志中心。现在只有这一份；run.js 开头还会对一遍代码里实际定义了哪些页面，
 * 新加了页面没登记到这里，npm test 直接失败。
 */
const fs = require('fs');
const path = require('path');

const PAGES = ['home', 'versions', 'download', 'mods', 'planner', 'repair', 'tasks', 'logs', 'java', 'accounts', 'skins', 'settings'];
// 设置页分了类（rc2），一次只显示一类
const SETTINGS = ['general', 'look', 'game', 'download', 'data', 'a11y', 'about'];
// 跟着选中的配置变的页面：按钮走查默认在装了 Fabric 的配置下走，这几页再在纯原版配置下走一遍（walk.js --profile=Vanilla）
const BY_PROFILE = ['home', 'repair']; // Mod 页不用：选中的配置没装加载器时它自己显示第一个装了的

/** 代码里实际定义的页面（A.pages.xxx = …） */
function definedPages(repo) {
  const dir = path.join(repo, 'src', 'renderer', 'js', 'pages');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const out = new Set();
  for (const f of walk(dir).filter((x) => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bA\.pages\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) out.add(m[1]);
  }
  return [...out].sort();
}

module.exports = { PAGES, SETTINGS, BY_PROFILE, definedPages };
