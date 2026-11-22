'use strict';
/**
 * 游戏日志一行的等级标记（rc9）：实时日志（launcher.js）和日志中心读存下来的文件（gamelogs.js）
 * 以前各有一份认标记的规则，写法不一样，同一行在两边的颜色可能不同。认标记只留这一份；
 * 没有标记的行怎么算，两边各有各的上下文（实时的知道这条日志事件的等级，读文件的只能跟着上一行），不放在这里
 */
const LOG4J_RE = /\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]/; // [Render thread/INFO]
const PLAIN_RE = /\[(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|SEVERE)\]/; // 老版本、Forge 安装器的 [INFO]

/** 这一行带的等级标记；没有返回 null */
function tagged(text) {
  const m = String(text).match(LOG4J_RE) || String(text).match(PLAIN_RE);
  if (!m) return null;
  return m[1] === 'WARNING' ? 'WARN' : m[1] === 'SEVERE' ? 'ERROR' : m[1];
}

module.exports = { tagged };
