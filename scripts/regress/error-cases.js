'use strict';
/**
 * errors.describe 的对照表（2.0.0-pre7）。pre5.js 的 error-names 场景用它，也可以拿去跑旧代码比。
 * NAMES：句子里的名字碰巧是关键词，不能当成网络、权限这类错误。
 * REAL：真的技术错误，还是要认得出来。
 */
const NM = (s) => `\u2068${s}\u2069`;

const NAMES = [
  '配置 certificate 不存在',
  '版本 certificate-x 不存在或其 JSON 已损坏',
  '版本 EPERM-x 不存在或其 JSON 已损坏',
  '「EPERM 存档」里有文件正被别的程序占着（可能是游戏还开着）',
  '「CERT_备份」还有任务在进行（备份）',
  '世界「socket hang up」不存在',
  '版本 ENOSPC 已存在',
  '版本 ETIMEDOUT 已存在',
  '配置 校验失败 不存在',
  '配置 下载停滞 不存在',
  '配置 请求超时 不存在',
  '配置 磁盘空间不足 不存在',
  '缺少文件且无下载地址：certificate.jar',
  '缺少文件且无下载地址：EPERM.jar',
  '缺少文件且无下载地址：ECONNRESET.zip',
  '文件已损坏（校验和不对）：socket-hang-up.jar',
  `找不到配置 ${NM('My certificate has expired')}`,
  `版本 ${NM('EPERM')} 不存在`,
  `补全 ${NM('read ECONNRESET')} 失败`,
];

// [错误（消息或带 code 的对象），应该认成的 code]
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const REAL = [
  ['ENOSPC: no space left on device, write', 'DISK_FULL'],
  [err('磁盘空间不足：需要约 3 GB，D:\\ 只剩 1 GB'), 'DISK_FULL'],
  ['EPERM: operation not permitted, open \'a.txt\'', 'PERMISSION'],
  ['spawn EPERM', 'PERMISSION'],
  ['EACCES: permission denied, mkdir \'x\'', 'PERMISSION'],
  [err('rename failed', { code: 'EPERM', syscall: 'rename' }), 'FILE_BUSY'],
  ['EBUSY: resource busy or locked, unlink \'x\'', 'FILE_BUSY'],
  ['ENAMETOOLONG: name too long, open \'x\'', 'PATH_TOO_LONG'],
  [err('x', { code: 'ENOENT' }), 'FILE_MISSING'],
  // 路径里有关键词：认的是错误码，不是路径
  [err("ENOENT: no such file or directory, open 'C:\\EPERM\\certificate\\x.json'", { code: 'ENOENT' }), 'FILE_MISSING'],
  [err('文件校验失败（a.jar）', { code: 'CHECKSUM' }), 'CHECKSUM'],
  ['文件校验失败（a.jar）', 'CHECKSUM'],
  ['文件大小不匹配（a.jar）', 'CHECKSUM'],
  ['net::ERR_INTERNET_DISCONNECTED', 'OFFLINE'],
  ['connect ENETUNREACH 1.2.3.4:443', 'OFFLINE'],
  ['net::ERR_NAME_NOT_RESOLVED', 'DNS'],
  ['getaddrinfo ENOTFOUND launchermeta.mojang.com', 'DNS'],
  ['getaddrinfo EAI_AGAIN launchermeta.mojang.com', 'DNS'],
  ['net::ERR_PROXY_CONNECTION_FAILED', 'PROXY'],
  ['net::ERR_TUNNEL_CONNECTION_FAILED', 'PROXY'],
  ['net::ERR_CERT_DATE_INVALID', 'TLS'],
  ['net::ERR_SSL_PROTOCOL_ERROR', 'TLS'],
  ['certificate has expired', 'TLS'],
  ['unable to verify the first certificate', 'TLS'],
  ['self signed certificate in certificate chain', 'TLS'],
  ['self-signed certificate', 'TLS'],
  ['unable to get local issuer certificate', 'TLS'],
  ["Hostname/IP does not match certificate's altnames: Host: a. is not in the cert's altnames", 'TLS'],
  ['CERT_HAS_EXPIRED', 'TLS'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS'],
  ['net::ERR_CONNECTION_TIMED_OUT', 'TIMEOUT'],
  ['connect ETIMEDOUT 1.2.3.4:443', 'TIMEOUT'],
  ['请求超时：launchermeta.mojang.com', 'TIMEOUT'],
  ['下载停滞（a.com/x）', 'STALLED'],
  ['net::ERR_CONNECTION_RESET', 'RESET'],
  ['read ECONNRESET', 'RESET'],
  ['socket hang up', 'RESET'],
  ['net::ERR_NETWORK_CHANGED', 'RESET'],
  ['net::ERR_CONNECTION_REFUSED', 'REFUSED'],
  ['connect ECONNREFUSED 127.0.0.1:443', 'REFUSED'],
  // 中文句子包了一层原始错误：冒号后面的还要认得出来
  ['无法读取压缩包 a.zip：read ECONNRESET', 'RESET'],
  ['下载失败：net::ERR_CONNECTION_RESET', 'RESET'],
  ['登录失败：certificate has expired', 'TLS'],
  ['复制失败：EPERM: operation not permitted, open \'x\'', 'PERMISSION'],
  ['安装失败：请求超时：a.com', 'TIMEOUT'],
  // 英文消息里的网址、引号里的路径不算
  [err('request to https://x.com/certificate/EPERM failed, reason: getaddrinfo ENOTFOUND x.com'), 'DNS'],
];

/** 跑一遍，返回不对的 */
function run(describe) {
  const bad = [];
  for (const m of NAMES) {
    const r = describe(new Error(m));
    if (r.code !== 'UNKNOWN') bad.push(`名字被当成 ${r.code}：${m}`);
  }
  for (const [e, want] of REAL) {
    const r = describe(typeof e === 'string' ? new Error(e) : e);
    if (r.code !== want) bad.push(`应该是 ${want}，认成 ${r.code}：${typeof e === 'string' ? e : e.message}`);
  }
  return { bad, total: NAMES.length + REAL.length };
}

module.exports = { NAMES, REAL, run };
