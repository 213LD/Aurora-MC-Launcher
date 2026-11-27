'use strict';
/** IPC：账户、皮肤、MC 百科 */

const config = require('../engine/config');
const versions = require('../core/versions');
const accounts = require('../core/auth/accounts');
const mods = require('../core/mods');
const skins = require('../core/skins');
const mcmod = require('../core/mcmod');
const { handle, send, startTask } = require('./bus');

function register() {
  // ── 账户 ──
  handle('accounts:list', () => {
    accounts.syncMissingMicrosoftSkins(() => send('accounts:changed'));
    return accounts.list();
  });
  handle('accounts:addOffline', async (name, uuid) => { const r = await accounts.addOffline(name, uuid); send('accounts:changed'); return r; });
  // 外置登录（1.8.0）：密码只经过这一次调用，不写日志、不保存
  handle('accounts:yggLogin', async (opts) => { const r = await accounts.yggLogin(opts); if (r.account) send('accounts:changed'); return r; });
  handle('accounts:yggPresets', () => accounts.yggPresets());
  handle('accounts:msStart', () => accounts.msStart());
  handle('accounts:msWait', async () => {
    const r = await accounts.msWait((s) => send('accounts:msStep', s));
    send('accounts:changed');
    return r;
  });
  handle('accounts:msCancel', () => accounts.msCancel());
  handle('accounts:refresh', async (id) => { const r = await accounts.refresh(id); send('accounts:changed'); return r; });
  handle('accounts:remove', async (id) => { const r = await accounts.remove(id); send('accounts:changed'); return r; });
  handle('accounts:select', async (id) => { const r = await accounts.select(id); send('accounts:changed'); return r; });
  handle('accounts:offlineUUID', (name) => accounts.offlineUUID(name || ''));
  // 皮肤
  handle('skins:set', async (id, patch) => { const r = await accounts.setSkin(id, patch); send('accounts:changed'); return r; });
  handle('skins:fetch', (q) => skins.fetchSkin(q || {}));
  handle('skins:defaults', () => skins.defaults());
  handle('skins:library', () => skins.library());
  handle('skins:libraryAdd', (item) => skins.libraryAdd(item || {}));
  handle('skins:libraryRemove', (hash) => skins.libraryRemove(hash));
  handle('skins:libraryRead', (hash) => skins.libraryRead(hash));
  // MC 百科中文信息（实验性）：IPC 在 core/mcmod.js 里注册。公开版换成概念演示的替身（src/edition/public），那边什么都不注册
  mcmod.register(handle, { config, versions, mods, startTask, send });
  // 皮肤中心
  // 补拉正版皮肤在后台做，不等它：网慢的时候皮肤中心不该卡住；补完了推 accounts:changed，皮肤中心跟着刷新
  handle('skins:libraryAll', () => {
    accounts.syncMissingMicrosoftSkins(() => send('accounts:changed'));
    return skins.libraryAll();
  });
  handle('skins:libraryUpdate', (hash, patch) => skins.libraryUpdate(hash, patch || {}));
  handle('skins:libraryGroup', (q) => skins.libraryGroup(q || {}));
  handle('skins:scanFolder', (dir) => {
    // 文件夹是玩家在对话框里选的：只收绝对路径（相对路径会按启动器自己的工作目录去找）
    if (typeof dir !== 'string' || !require('path').isAbsolute(dir)) throw new Error('文件夹路径不对');
    return skins.scanFolder(dir);
  });
  // 把账户当前的皮肤收藏进皮肤库
  handle('skins:collect', async (id) => {
    const acc = accounts.find(id);
    const tex = acc && acc.id === id ? await skins.readTexture(acc, 'skin') : null;
    if (!tex) throw new Error('这个账户还在用默认皮肤');
    const model = (acc.custom || acc.skinCache || {}).model || 'classic';
    return skins.libraryAdd({ png: tex.buf, model, name: `${acc.name} 的皮肤` });
  });
}

module.exports = register;
