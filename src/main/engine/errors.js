'use strict';
/**
 * 把底层错误（网络、文件系统、HTTP、校验）翻译成用户能看懂的原因与建议
 */

// 判断原因时只看技术原文（2.0.0-pre7）：我们自己写的句子里有玩家起的名字，名字碰巧是 certificate、EPERM、校验失败，
// 不能说成证书错误、没有写入权限。t 是技术原文（见 technicalText），own 判断句子是不是以这段我们自己写的话开头
const CJK = /[\u4e00-\u9fff]/;
const NM_PART = /\u2068[^\u2069]*\u2069/g;
function technicalText(msg) {
  const s = msg.replace(NM_PART, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/(^|[\s,(=])(?:'[^']*'|"[^"]*")(?=$|[\s,).:])/g, '$1');
  if (!CJK.test(s)) return s;
  // 中文句子：只有冒号后面包着的原始错误才算（「无法读取压缩包 a.zip：read ECONNRESET」）
  const tail = s.match(/[：:]\s*([^\u4e00-\u9fff：]+)$/);
  return tail ? tail[1].trim() : '';
}
// 错误码要是单独的一个词：EPERM.jar、certificate-x 这样的文件名和配置名不算
const rawCode = (codes) => new RegExp(`(^|[\\s,(])(${codes})(:|,|\\)|\\s|$)`);
const own = (msg, re) => re.test(msg.replace(NM_PART, ' '));
const TLS_TEXT = /ERR_CERT|ERR_SSL|ERR_BAD_SSL|\bCERT_[A-Z_]+\b|\b[A-Z_]*SELF_SIGNED[A-Z_]*\b|\bUNABLE_TO_(VERIFY|GET)[A-Z_]*\b|certificate (has|is|verify|chain|not|signature|revoked|expired|required|unknown)|(self[- ]signed|first|leaf|issuer|invalid|bad|unknown|no) certificate|certificate's altnames/i;

const RULES = [
  { code: 'CANCELLED', test: (e) => e && e.cancelled, message: '已取消', hint: '' },
  { code: 'DISK_FULL', test: (e, t, m) => e.code === 'ENOSPC' || rawCode('ENOSPC').test(t) || own(m, /(^|：)\s*磁盘空间不足/), message: '磁盘空间不足', hint: '请清理磁盘空间，或在「设置 → 游戏目录」中换到空间更大的磁盘' },
  // Windows 上改名时里面有文件被占着，报的是 EPERM
  { code: 'FILE_BUSY', test: (e) => e.code === 'EPERM' && e.syscall === 'rename', message: '文件被占用', hint: '请关闭正在运行的游戏或占用该文件的程序后重试' },
  { code: 'PERMISSION', test: (e, t) => ['EACCES', 'EPERM', 'EROFS'].includes(e.code) || (!e.code && rawCode('EACCES|EPERM|EROFS').test(t)), message: '没有写入权限', hint: '游戏目录可能位于受保护的位置（如 Program Files），或被杀毒软件拦截；可以换一个游戏目录后重试' },
  { code: 'FILE_BUSY', test: (e, t) => e.code === 'EBUSY' || rawCode('EBUSY').test(t) || /resource busy or locked/.test(t), message: '文件被占用', hint: '请关闭正在运行的游戏或占用该文件的程序后重试' },
  { code: 'PATH_TOO_LONG', test: (e, t) => e.code === 'ENAMETOOLONG' || rawCode('ENAMETOOLONG').test(t), message: '文件路径过长', hint: '请把游戏目录放在更短的路径下（例如 D:\\Minecraft）' },
  { code: 'FILE_MISSING', test: (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR', message: '找不到文件或文件夹', hint: '可能已经被移动或删除了，刷新一下再试' },
  { code: 'FILE_EXISTS', test: (e) => e.code === 'EEXIST' || e.code === 'ENOTEMPTY', message: '已经有同名的文件或文件夹', hint: '换个名字，或者先处理掉那个同名的' },
  { code: 'TOO_MANY_FILES', test: (e) => e.code === 'EMFILE' || e.code === 'ENFILE', message: '同时打开的文件太多', hint: '稍等一会儿再试，还不行就重启启动器' },
  { code: 'CHECKSUM', test: (e, t, m) => e.code === 'CHECKSUM' || own(m, /(^|：)\s*((文件)?校验失败|文件大小不匹配)/), message: '文件校验失败', hint: '下载的内容与官方记录不一致，可能是网络劫持或镜像源上的文件损坏；请在设置中切换下载源后重试' },
  { code: 'OFFLINE', test: (e, t) => /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_ACCESS_DENIED|ERR_ADDRESS_UNREACHABLE/.test(t) || rawCode('ENETUNREACH').test(t), message: '网络未连接', hint: '请检查网络连接后重试' },
  { code: 'DNS', test: (e, t) => /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(t) || rawCode('ENOTFOUND|EAI_AGAIN').test(t), message: '无法解析服务器地址', hint: '请检查网络或 DNS 设置；也可以尝试切换下载源' },
  { code: 'PROXY', test: (e, t) => /ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED/.test(t), message: '代理连接失败', hint: '请检查系统代理设置是否可用' },
  { code: 'TLS', test: (e, t) => TLS_TEXT.test(t), message: '安全连接失败（证书错误）', hint: '请确认系统时间正确，并检查是否有软件拦截了 HTTPS 连接' },
  { code: 'TIMEOUT', test: (e, t, m) => e.code === 'TIMEOUT' || /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(t) || rawCode('ETIMEDOUT').test(t) || own(m, /(^|：)\s*请求超时/), message: '连接超时', hint: '网络较慢或服务器无响应；可以切换下载源，或在设置中降低并发下载数' },
  { code: 'STALLED', test: (e, t, m) => e.code === 'STALLED' || own(m, /(^|：)\s*下载停滞/), message: '下载停滞', hint: '长时间没有收到数据，网络可能不稳定；可以稍后重试或切换下载源' },
  { code: 'RESET', test: (e, t) => /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_HTTP2|socket hang up|ERR_NETWORK_CHANGED/.test(t) || rawCode('ECONNRESET').test(t), message: '连接被中断', hint: '连接被服务器、防火墙或不稳定的网络中断；可以重试或切换下载源' },
  { code: 'REFUSED', test: (e, t) => /ERR_CONNECTION_REFUSED/.test(t) || rawCode('ECONNREFUSED').test(t), message: '服务器拒绝连接', hint: '下载源暂时不可用，可以切换下载源' },
  { code: 'NOT_FOUND', test: (e) => e.status === 404, message: '文件不存在（HTTP 404）', hint: '当前下载源上没有该文件，可以切换下载源后重试' },
  { code: 'FORBIDDEN', test: (e) => e.status === 401 || e.status === 403, message: `访问被拒绝（HTTP 403）`, hint: '下载源拒绝了请求，可以切换下载源后重试' },
  { code: 'RATE_LIMIT', test: (e) => e.status === 429, message: '请求过于频繁（HTTP 429）', hint: '下载源限制了访问频率，请稍等片刻后重试' },
  { code: 'SERVER', test: (e) => e.status >= 500, message: '服务器错误', hint: '下载源暂时出现故障，可以切换下载源或稍后重试' },
];

function describe(err) {
  const e = err || {};
  const msg = String(e.message || e);
  const tech = technicalText(msg);
  for (const r of RULES) {
    try {
      if (r.test(e, tech, msg)) {
        return { code: r.code, message: r.code === 'SERVER' ? `服务器错误（HTTP ${e.status}）` : r.message, hint: r.hint };
      }
    } catch { /* ignore */ }
  }
  return { code: e.code || 'UNKNOWN', message: msg, hint: '' };
}

/**
 * 给玩家看的错误文字（2.0.0-pre5）：Node 的文件错误（ENOENT: no such file…）换成原因加文件名，
 * 其他已经写好的话不动。错误码留在 reason 里，原文在日志里
 */
function friendly(err) {
  const msg = String((err && err.message) || err || '');
  const raw = msg.match(/^(E[A-Z0-9]+): /);
  if (!raw) return msg;
  const r = describe(err);
  const what = r.code === 'UNKNOWN' || r.code === raw[1] ? `文件操作失败（${raw[1]}）` : r.message;
  const file = (err && err.path) || (msg.match(/'([^']+)'/) || [])[1];
  return file ? `${what}：${String(file).split(/[\\/]/).pop()}` : what;
}

/** 构造一个带有结构化原因的错误 */
function withReason(message, reason, extra = {}) {
  const e = new Error(message);
  e.reason = reason;
  Object.assign(e, extra);
  return e;
}

module.exports = { describe, friendly, withReason };
