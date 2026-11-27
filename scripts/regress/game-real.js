'use strict';
/**
 * 真的进游戏（2.0.0-pre2，接手以前人工测的部分）。electron scripts/regress/game-real.js <场景>（run.js --real 全跑）
 * 环境变量见 game-kit.js。全部在隔离目录；账号用本地模拟服务器，真账号不碰；结束只关测试自己启动的游戏。
 * 量不出来的：画面好不好看、手感；游戏截图放在 AURORA_REGRESS_DIR/game-shots，供看图判断。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, net } = require('electron');
const H = require('./harness');
const { SRC, JAVA, MC, makeWorld, writeOptions, makeProfile, prepareGame, waitInWorld, killAll, common } = require('./game-kit');

const { sleep, waitFor, setup, core, ipc, check, finish, BASE } = H;
const SHOTS = path.join(BASE, 'game-shots');

const psRun = (cmd, ms = 30000) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { windowsHide: true, encoding: 'utf8', timeout: ms }, (err, out) => res(String(out || '').trim())));

/** 让游戏自己正常退出（发关闭窗口，只发给这个 pid），它会保存世界 */
async function closeGame(gameId, timeoutMs = 90000) {
  const launcher = core('launcher');
  const g = launcher.getGame(gameId);
  if (!g || g.state === 'exited') return true;
  const pid = g.pid || (g.child && g.child.pid);
  await psRun(`$p = Get-Process -Id ${pid} -EA SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const x = launcher.getGame(gameId); if (!x || x.state === 'exited') return true; await sleep(500); }
  return false;
}

/** 给游戏窗口截图（不抢焦点，用 PrintWindow），返回「不是纯黑」的比例 */
async function shotGame(gameId, name) {
  const g = core('launcher').getGame(gameId);
  const pid = g && (g.pid || (g.child && g.child.pid));
  await fsp.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  const out = await psRun(`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r); public struct R { public int L, T, Rg, B; } }
"@
$p = Get-Process -Id ${pid}; $h = $p.MainWindowHandle; $r = New-Object W+R; [void][W]::GetClientRect($h, [ref]$r)
$bm = New-Object System.Drawing.Bitmap ([Math]::Max(1,$r.Rg)), ([Math]::Max(1,$r.B)); $gr = [System.Drawing.Graphics]::FromImage($bm); $dc = $gr.GetHdc(); [void][W]::PrintWindow($h, $dc, 2); $gr.ReleaseHdc($dc); $gr.Dispose()
$c = 0; $t = 0; for ($x = 0; $x -lt $bm.Width; $x += 16) { for ($y = 0; $y -lt $bm.Height; $y += 16) { $t++; $px = $bm.GetPixel($x, $y); if ($px.R + $px.G + $px.B -gt 30) { $c++ } } }
$bm.Save('${file.replace(/'/g, "''")}'); "$c/$t"`);
  return out;
}

function lines(gameId) { const g = core('launcher').getGame(gameId); return g ? g.lines.map((x) => x.text) : []; }

async function installWait(bus, opts) {
  const tasks = core('tasks');
  const r = await bus.call('versions:install', opts);
  if (!r.ok) return { ok: false, error: r.error };
  const end = Date.now() + 900000;
  while (Date.now() < end) {
    const t = tasks.list().find((x) => x.id === r.data);
    if (t && t.status === 'done') return { ok: true };
    if (t && (t.status === 'failed' || t.status === 'cancelled')) return { ok: false, error: t.detail || t.error || t.status };
    await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
  }
  return { ok: false, error: '安装超时' };
}

/** 进世界：做好世界、选项，启动，等进世界。返回 { ok, id } */
async function enterWorld(c, id, world, extraOptions = '') {
  const info = await c.versions.versionInfo(id);
  const gd = c.versions.gameDirFor(id, info);
  await makeWorld(path.join(gd, 'saves'), world);
  await writeOptions(gd);
  if (extraOptions) await fsp.appendFile(path.join(gd, 'options.txt'), extraOptions);
  c.config.setVersionSettings(id, { gameArgs: `--quickPlaySingleplayer ${world}` });
  const r = await c.bus.call('launch:start', id, {});
  if (!r.ok) return { ok: false, why: r.error };
  const w = await waitInWorld(id, r.data.id, 420000);
  return { ...w, id: r.data.id, gd };
}

async function modrinthFile(slug, loader, mc = MC, type = null) {
  const q = `game_versions=${encodeURIComponent(JSON.stringify([mc]))}${loader ? `&loaders=${encodeURIComponent(JSON.stringify([loader]))}` : ''}`;
  const res = await net.fetch(`https://api.modrinth.com/v2/project/${slug}/version?${q}`, { headers: { 'User-Agent': 'aurora-launcher-regress' } });
  const list = await res.json();
  const v = list[0];
  const f = v.files.find((x) => x.primary) || v.files[0];
  return { url: f.url, filename: f.filename, sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.size, deps: v.dependencies };
}
async function download(file, dest) {
  const res = await net.fetch(file.url);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** 手工做一个 Fabric Mod（只有 fabric.mod.json） */
async function fakeFabricMod(file, id, extra = {}) {
  const { ZipWriter } = core('zip');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const z = await ZipWriter.create(file);
  await z.addBuffer('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', name: id, ...extra })));
  await z.close();
}

async function fabricProfile(c, name) {
  const list = await c.bus.call('loaders:list', 'fabric', MC);
  const v = (list.data || []).find((x) => x.stable) || (list.data || [])[0];
  const r = await installWait(c.bus, { mc: MC, name, loader: { type: 'fabric', version: v.version }, asProfile: true, isolation: { preset: 'isolated' } });
  return r;
}

// ── 本地模拟服务器 ──
function yggMock() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const uuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const state = { requests: [], token: 'tok-1', refreshed: 0, invalid: false, joined: 0 };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQ0lEQVR42u3PMQEAAAgDoJnc6BrDxwMNyDxNiYiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI3mkBhQ0AAcvmB/gAAAAASUVORK5CYII=', 'base64');
  let base = '';
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'x-authlib-injector-api-location': '/api/yggdrasil/' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
  const profile = () => {
    const tex = Buffer.from(JSON.stringify({ timestamp: Date.now(), profileId: uuid, profileName: 'MockPlayer', textures: { SKIN: { url: `${base}/textures/skin.png` } } })).toString('base64');
    const signature = crypto.createSign('SHA1').update(tex).sign(privateKey, 'base64');
    return { id: uuid, name: 'MockPlayer', properties: [{ name: 'textures', value: tex, signature }] };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = req.url.replace(/^\/api\/yggdrasil/, '');
      state.requests.push(`${req.method} ${url.split('?')[0]}`);
      const data = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};
      if (req.method === 'GET' && (url === '/' || url === '')) return send(res, 200, { meta: { serverName: '本地模拟服务器', implementationName: 'mock', implementationVersion: '1' }, skinDomains: ['127.0.0.1', 'localhost'], signaturePublickey: publicKey.export({ type: 'spki', format: 'pem' }) });
      if (url === '/authserver/authenticate') {
        if (data.password !== 'right-password') return send(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' });
        return send(res, 200, { accessToken: state.token, clientToken: data.clientToken, availableProfiles: [{ id: uuid, name: 'MockPlayer' }], selectedProfile: { id: uuid, name: 'MockPlayer' }, user: { id: 'user1' } });
      }
      if (url === '/authserver/refresh') {
        if (state.invalid === 'refresh') return send(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid token.' });
        state.refreshed++; state.token = `tok-${state.refreshed + 1}`;
        return send(res, 200, { accessToken: state.token, clientToken: data.clientToken, selectedProfile: { id: uuid, name: 'MockPlayer' } });
      }
      if (url === '/authserver/validate') return state.invalid || data.accessToken !== state.token ? send(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid token.' }) : send(res, 204, null);
      if (url === '/authserver/invalidate') return send(res, 204, null);
      if (url === '/sessionserver/session/minecraft/join') { state.joined++; return send(res, 204, null); }
      if (url.startsWith('/sessionserver/session/minecraft/hasJoined')) return send(res, 200, profile());
      if (url.startsWith('/sessionserver/session/minecraft/profile/')) return send(res, 200, profile());
      if (url.startsWith('/api/profiles/minecraft')) return send(res, 200, [{ id: uuid, name: 'MockPlayer' }]);
      if (url.startsWith('/textures/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
      return send(res, 404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, state, url: `${base}/api/yggdrasil`, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) });
  }));
}

/** 微软、Xbox、Minecraft 的接口：换掉 net.fetch，不出本机 */
function msMock(st) {
  const real = net.fetch;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
  net.fetch = async (url, opts = {}) => {
    const u = String(url);
    st.calls.push(new URL(u).host + new URL(u).pathname);
    if (u.includes('/oauth2/v2.0/devicecode')) {
      st.dcBodies = st.dcBodies || [];
      st.dcBodies.push(String(opts.body || ''));
      return json({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://www.microsoft.com/link', expires_in: 60, interval: st.dcInterval || 1, message: '打开网页输入代码' });
    }
    if (u.includes('/oauth2/v2.0/token')) {
      const body = String(opts.body || '');
      if (body.includes('refresh_token')) { st.refreshBodies = st.refreshBodies || []; st.refreshBodies.push(body); }
      if (body.includes('refresh_token') && st.refreshDelay) await new Promise((r) => setTimeout(r, st.refreshDelay));
      if (body.includes('refresh_token') && st.refreshBad) return json({ error: 'invalid_grant', error_description: 'expired' }, 400);
      if (body.includes('refresh_token') && st.refreshFlaky) return json({ error: 'temporarily_unavailable', error_description: 'try later' }, 503);
      st.polls = (st.polls || 0) + 1;
      if (!body.includes('refresh_token') && st.polls < 2) return json({ error: 'authorization_pending' }, 400);
      return json({ access_token: 'ms-access', refresh_token: `ms-refresh-${st.polls}`, expires_in: 3600 });
    }
    if (u.includes('user.auth.xboxlive.com')) return json({ Token: 'xbl', DisplayClaims: { xui: [{ uhs: 'uhs1' }] } });
    if (u.includes('xsts.auth.xboxlive.com')) return st.noXbox ? json({ XErr: 2148916233 }, 401) : json({ Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'uhs1' }] } });
    if (u.includes('login_with_xbox')) return json({ access_token: jwt, expires_in: 86400 });
    if (u.includes('/entitlements/')) return json({ items: st.noGame ? [] : [{ name: 'game_minecraft' }, { name: 'product_minecraft' }] });
    if (u.includes('/minecraft/profile')) return st.noGame ? json({ error: 'NOT_FOUND' }, 404) : json({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'MsMock', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/mock-ms-skin', variant: 'CLASSIC' }], capes: [] });
    if (u === 'https://textures.minecraft.net/texture/mock-ms-skin') {
      if (st.texDelay) await new Promise((r) => setTimeout(r, st.texDelay)); // 模拟网很慢
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQ0lEQVR42u3PMQEAAAgDoJnc6BrDxwMNyDxNiYiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI3mkBhQ0AAcvmB/gAAAAASUVORK5CYII=', 'base64');
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return real(url, opts);
  };
  return () => { net.fetch = real; };
}

const SCENARIOS = {
  /** 进世界 → 正常退出 → 存档真的写了 → 再进还在 */
  async save() {
    const c = await common('real-save');
    await makeProfile(c.game, 'SaveP');
    c.config.setVersionSettings('SaveP', { isolation: 'on' });
    await c.profiles.writeMeta('SaveP', { type: 'vanilla' });
    const w = await enterWorld(c, 'SaveP', 'SaveWorld');
    check('real', '真的进了世界', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    await waitFor(() => fs.existsSync(path.join(w.gd, 'saves', 'SaveWorld', 'session.lock')) && fs.existsSync(path.join(w.gd, 'saves', 'SaveWorld', 'level.dat')), 60000);
    const gd = w.gd;
    const dir = path.join(gd, 'saves', 'SaveWorld');
    const nbt = core('nbt');
    const zlib = require('zlib');
    const read = async () => nbt.parse ? nbt.parse(zlib.gunzipSync(await fsp.readFile(path.join(dir, 'level.dat')))) : null;
    const before = fs.statSync(path.join(dir, 'level.dat')).mtimeMs;
    const lockHeld = fs.existsSync(path.join(dir, 'session.lock'));
    const closed = await closeGame(w.id);
    const log = lines(w.id).join('\n');
    check('real', '发关闭窗口：游戏自己正常退出，没有被强杀', closed && /Stopping!|Stopping worker threads|Saving/.test(log), { closed, tail: lines(w.id).slice(-3) });
    const st = fs.statSync(path.join(dir, 'level.dat'));
    check('real', '退出后 level.dat 更新了，区域文件和玩家数据都写了', st.mtimeMs > before && fs.existsSync(path.join(dir, 'region')) && fs.readdirSync(path.join(dir, 'region')).length > 0 && fs.existsSync(path.join(dir, 'playerdata')) && fs.readdirSync(path.join(dir, 'playerdata')).length > 0, { lockHeld, region: fs.existsSync(path.join(dir, 'region')) ? fs.readdirSync(path.join(dir, 'region')).length : 0 });
    const regionFiles = fs.readdirSync(path.join(dir, 'region'));
    const pdata = fs.readdirSync(path.join(dir, 'playerdata')).filter((n) => n.endsWith('.dat'));
    const playerBefore = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, 'playerdata', pdata[0]))).digest('hex');
    // 再进一次：用同一个世界（不重新做 level.dat）
    const r = await c.bus.call('launch:start', 'SaveP', {});
    const w2 = r.ok ? await waitInWorld('SaveP', r.data.id, 300000) : { ok: false, why: r.error };
    check('real', '再进同一个世界：能进，不是新建的', w2.ok && regionFiles.every((n) => fs.existsSync(path.join(dir, 'region', n))), w2.ok ? regionFiles.length : w2);
    if (r.ok) { const shot = await shotGame(r.data.id, 'save-world'); console.log(`  游戏截图不是黑屏的采样点：${shot}`); }
    if (r.ok) await closeGame(r.data.id);
    check('real', '第二次也正常退出，玩家数据还在', fs.existsSync(path.join(dir, 'playerdata', pdata[0])), { same: playerBefore === crypto.createHash('md5').update(fs.readFileSync(path.join(dir, 'playerdata', pdata[0]))).digest('hex') });
    await killAll();
  },

  /** 日志中心（rc4）：真的进一次世界再正常退出，这一局的完整日志存进了数据目录，记下了结果 */
  async logs() {
    const c = await common('real-logs');
    await makeProfile(c.game, 'LogP');
    await c.profiles.writeMeta('LogP', { type: 'vanilla' });
    const w = await enterWorld(c, 'LogP', 'LogWorld');
    check('logs', '真的进了世界', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    const gamelogs = core('gamelogs');
    const during = (await gamelogs.list()).find((x) => x.versionId === 'LogP');
    check('logs', '玩的时候：日志中心里这一局标着「正在运行」，文件已经在写', during && during.state === 'running' && during.bytes > 0, during);
    await closeGame(w.id);
    for (let i = 0; i < 20 && !(core('launcher').getGame(w.id) || {}).finalized; i++) await sleep(500);
    const mem = lines(w.id);
    const it = (await gamelogs.list()).find((x) => x.versionId === 'LogP');
    check('logs', '退出以后：这一局记成正常退出，开始和结束时间都有', it && it.state === 'exited' && it.exitCode === 0 && it.endedAt > it.startedAt && !it.crash, it);
    const r = it ? await gamelogs.read(it.id, { tail: 20000 }) : { lines: [], total: 0 };
    const text = r.lines.map((l) => l.text).join('\n');
    check('logs', '存下来的是完整日志：启动器的说明、进世界、退出都在，行数和内存里的一样', /\[Aurora\] 启动 LogP/.test(text) && /joined the game|logged in with entity id/.test(text) && /Stopping!|Saving/.test(text) && r.total >= mem.length, { total: r.total, mem: mem.length });
    check('logs', '等级认得出来（有 INFO，WARN 的行标成 WARN）', r.lines.some((l) => l.level === 'INFO') && r.lines.filter((l) => /\/WARN\]/.test(l.text)).every((l) => l.level === 'WARN'), r.lines.filter((l) => l.level !== 'INFO').length);
    await killAll();
  },

  /**
   * 一键 Debug / 测试启动记住玩家回答过的画面（2026-11-07）：真的测试启动两次，进主菜单后「看画面」换成一个固定的认不出的画面。
   * 第一次问玩家、记下回答；第二次同一个画面不再问，照上次的回答；「重新问我」之后第三次又会问
   */
  async screenmem() {
    const c = await common('real-screenmem');
    await makeProfile(c.game, 'MemTest');
    await c.profiles.writeMeta('MemTest', { type: 'vanilla' });
    const screens = core('screens');
    const realLook = screens.look;
    // 要是认不出的画面：「Welcome…感谢安装」会被当成已知的 Mod 欢迎页，不问
    screens.look = async () => ({ kind: 'unknown', text: 'Notice from ExampleMod\nYour keybind profile was reset. Click OK to close this message', items: ['Notice from ExampleMod', 'Your keybind profile was reset. Click OK to close this message'], image: null });
    const { testLaunch } = require(path.join(H.REPO, 'src', 'main', 'core', 'troubleshoot', 'test.js'));
    const tasks = core('tasks');
    let asked = 0;
    const ask = async () => { asked++; return { answer: 'menu' }; };
    const run = () => tasks.run({ title: '测试启动', kind: 'test', meta: { name: 'MemTest' } }, (task) => testLaunch('MemTest', task, { ask }));
    try {
      const r1 = await run();
      check('一键 Debug', '第一次认不出画面：问了玩家，回答记下了', r1.ok && asked === 1 && !(r1.screen && r1.screen.remembered), { ok: r1.ok, asked, reason: r1.reason });
      const r2 = await run();
      check('一键 Debug', '第二次同一个画面：没再问，照上次的回答算主菜单，结果里带着说明', r2.ok && asked === 1 && r2.screen && r2.screen.remembered && r2.screen.remembered.answer === 'menu' && !r2.notices.some((n) => n.type === 'screen'), { ok: r2.ok, asked, screen: r2.screen && r2.screen.remembered });
      const f = await c.bus.call('troubleshoot:forgetScreen', 'MemTest', r2.screen && r2.screen.remembered && r2.screen.remembered.at);
      const r3 = await run();
      check('一键 Debug', '点了「重新问我」：第三次又问了', f.ok && r3.ok && asked === 2, { forget: f, asked });
      const bad = await c.bus.call('troubleshoot:forgetScreen', 'NoSuchProfile', 1);
      check('一键 Debug', '不存在的配置：拒绝，不建资料文件', !bad.ok && !fs.existsSync(path.join(c.game, 'versions', 'NoSuchProfile')), bad.error);
    } finally {
      screens.look = realLook;
      await killAll();
    }
  },

  /** 共享存档、测试副本的实际效果 */
  async modes() {
    const c = await common('real-modes');
    for (const id of ['SrcP', 'SharedP', 'SandP']) { await makeProfile(c.game, id); c.config.setVersionSettings(id, { isolation: 'on' }); await c.profiles.writeMeta(id, { type: 'vanilla' }); }
    const srcDir = c.versions.versionDir('SrcP');
    await makeWorld(path.join(srcDir, 'saves'), 'ModeWorld');
    const levelBefore = fs.statSync(path.join(srcDir, 'saves', 'ModeWorld', 'level.dat')).mtimeMs;
    const go = async (id) => {
      const gd = c.versions.gameDirFor(id, await c.versions.versionInfo(id));
      await writeOptions(gd);
      c.config.setVersionSettings(id, { gameArgs: '--quickPlaySingleplayer ModeWorld' });
      const r = await c.bus.call('launch:start', id, {});
      if (!r.ok) return { ok: false, why: r.error };
      const w = await waitInWorld(id, r.data.id, 300000);
      await sleep(4000); // pitfall-ok：进了世界以后玩几秒再关：要的是「玩过」的世界
      await closeGame(r.data.id);
      return w;
    };
    // 测试副本：原世界不动
    await c.bus.call('isolation:set', 'SandP', { preset: 'sandbox', source: 'SrcP' });
    const s1 = await go('SandP');
    const sandCopy = path.join(c.versions.versionDir('SandP'), 'saves', 'ModeWorld', 'level.dat');
    check('real', '测试副本：进的是副本，原世界一点没动', s1.ok && fs.existsSync(sandCopy) && fs.statSync(path.join(srcDir, 'saves', 'ModeWorld', 'level.dat')).mtimeMs === levelBefore, s1.ok ? '' : s1);
    // 共享存档：写的是原世界
    await c.bus.call('isolation:set', 'SharedP', { preset: 'shared', source: 'SrcP' });
    const s2 = await go('SharedP');
    check('real', '共享存档：进的是同一个世界，原世界更新了', s2.ok && fs.statSync(path.join(srcDir, 'saves', 'ModeWorld', 'level.dat')).mtimeMs > levelBefore && fs.existsSync(path.join(srcDir, 'saves', 'ModeWorld', 'region')), s2.ok ? '' : s2);
    await killAll();
  },

  // ── 加载器：真实安装，进世界 ──
  async fabric() { await SCENARIOS.loader('fabric', /Loading \d+ mods|fabricloader/i); },
  async forge() { await SCENARIOS.loader('forge', /fml\.|MinecraftForge|forge-/i); },
  async neoforge() { await SCENARIOS.loader('neoforge', /neoforge|NeoForge/); },
  async optifine() {
    const c = await common('real-optifine');
    const list = await c.bus.call('components:optifineList', MC);
    const entries = list.data || [];
    const entry = entries.find((x) => !/pre/i.test(x.patch || '')) || entries[0];
    check('real', `optifine：拿得到 ${MC} 的版本列表`, !!entry, list.ok ? `${entries.length} 个` : list.error);
    if (!entry) return;
    const id = 'Real optifine';
    const r0 = await installWait(c.bus, { mc: MC, name: id, asProfile: true, isolation: { preset: 'isolated' } });
    check('real', 'optifine：原版配置装好了', r0.ok, r0.error || '');
    if (!r0.ok) return;
    const t0 = Date.now();
    const tasks = core('tasks');
    const task = new tasks.Task('安装 OptiFine');
    const res = await core('components').installOptifine(id, entry, task).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
    check('real', `optifine：真实安装成功（${Math.round((Date.now() - t0) / 1000)} 秒）`, res.ok, res.ok ? entry.version : res.error);
    if (!res.ok) return;
    const w = await enterWorld(c, id, 'optifineWorld');
    const log = w.id ? lines(w.id).join('\n') : '';
    check('real', 'optifine：真的进了世界', w.ok, w.ok ? '' : { why: w.why, tail: w.tail });
    check('real', 'optifine：日志里确实是 OptiFine', /OptiFine/.test(log), log.slice(0, 200));
    if (w.ok) { await sleep(10000); console.log(`  游戏截图不是黑屏的采样点：${await shotGame(w.id, 'loader-optifine')}`); await closeGame(w.id); } // pitfall-ok：截图前让游戏画面画出来（只打印采样点，不判断）
    await killAll();
  },
  /** 中文和带空格的路径：Forge 安装器（清单 10-7）和游戏本身 */
  async forgecn() { await SCENARIOS.loader('forge', /fml\.|MinecraftForge|forge-/i, '真实 游戏 中文路径'); },
  async loader(type, re, dirName) {
    const c = await common(dirName || `real-${type}`);
    const list = await c.bus.call('loaders:list', type, MC);
    const all = list.data || [];
    const v = all.find((x) => x.recommended) || all.find((x) => x.stable) || all[0];
    check('real', `${type}：拿得到 ${MC} 的版本列表`, !!v, list.ok ? `${all.length} 个` : list.error);
    if (!v) return;
    const id = `Real ${type}`;
    const loader = type === 'optifine' ? { type, version: v.version || v.patch, entry: v } : { type, version: v.version };
    const t0 = Date.now();
    const r = await installWait(c.bus, { mc: MC, name: id, loader, asProfile: true, isolation: { preset: 'isolated' } });
    check('real', `${type}：真实安装成功（${Math.round((Date.now() - t0) / 1000)} 秒）`, r.ok, r.ok ? v.version : r.error);
    if (!r.ok) return;
    const w = await enterWorld(c, id, `${type}World`);
    const log = w.id ? lines(w.id).join('\n') : '';
    check('real', `${type}：真的进了世界`, w.ok, w.ok ? '' : { why: w.why, tail: w.tail });
    check('real', `${type}：日志里确实是这个加载器`, re.test(log), log.slice(0, 200));
    if (w.ok) { console.log(`  游戏截图不是黑屏的采样点：${await shotGame(w.id, `loader-${type}`)}`); await closeGame(w.id); }
    await killAll();
  },

  /** 光影和资源包真的生效：Fabric + Iris + 光影包 + 资源包 */
  async shader() {
    const c = await common('real-shader');
    const r = await fabricProfile(c, 'ShaderP');
    check('real', '光影：Fabric 配置装好了', r.ok, r.error || '');
    if (!r.ok) return;
    const gd = c.versions.versionDir('ShaderP');
    for (const [slug, sub] of [['fabric-api', 'mods'], ['sodium', 'mods'], ['iris', 'mods']]) {
      const f = await modrinthFile(slug, 'fabric');
      await download(f, path.join(gd, sub, f.filename));
    }
    const sp = await modrinthFile('complementary-reimagined', 'iris');
    await download(sp, path.join(gd, 'shaderpacks', sp.filename));
    const rp = await modrinthFile('faithful-32x', 'minecraft').catch(() => null) || await modrinthFile('faithful-32x', null);
    await download(rp, path.join(gd, 'resourcepacks', rp.filename));
    await fsp.mkdir(path.join(gd, 'config'), { recursive: true });
    await fsp.writeFile(path.join(gd, 'config', 'iris.properties'), `enableShaders=true\nshaderPack=${sp.filename}\n`);
    const w = await enterWorld(c, 'ShaderP', 'ShaderWorld', `resourcePacks:["vanilla","fabric","file/${rp.filename}"]\n`);
    const log = w.id ? lines(w.id).join('\n') : '';
    check('real', '光影：装了 Iris 和光影包能进世界', w.ok, w.ok ? '' : { why: w.why, tail: w.tail });
    check('real', '光影：日志里光影包生效了', new RegExp(`Using shaderpack|${sp.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)}`).test(log) && /\[?[Ii]ris\]?/.test(log), log.split('\n').filter((l) => /iris|shader/i.test(l)).slice(0, 3));
    check('real', '资源包：日志里资源包加载了', new RegExp(rp.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)).test(log), log.split('\n').filter((l) => /Reloading ResourceManager/i.test(l)).slice(0, 2));
    if (w.ok) { await sleep(6000); console.log(`  游戏截图不是黑屏的采样点：${await shotGame(w.id, 'shader-world')}`); await closeGame(w.id); } // pitfall-ok：截图前让游戏画面画出来（只打印采样点，不判断）
    await killAll();
  },

  /** 崩溃分析：故意放冲突的 Mod，看启动器说得对不对 */
  async crash() {
    const c = await common('real-crash');
    const r = await fabricProfile(c, 'CrashP');
    check('real', '崩溃：Fabric 配置装好了', r.ok, r.error || '');
    if (!r.ok) return;
    const mods = path.join(c.versions.versionDir('CrashP'), 'mods');
    const run = async (label, want) => {
      await writeOptions(c.versions.versionDir('CrashP'));
      const res = await c.bus.call('launch:start', 'CrashP', {});
      let text = res.ok ? '' : res.error;
      if (res.ok) {
        const out = await core('launcher').waitOutcome(res.data.id, { timeout: 120000 });
        const g = core('launcher').getGame(res.data.id);
        // Fabric 报这种错时自己开一个错误窗口等着，玩家关掉它进程才退出；崩溃弹窗的内容退出后才有
        // 窗口可能还没开出来（第一次要初始化界面库），关不到就过一会儿再关
        for (let i = 0; i < 8 && !out.ok && g && g.state !== 'exited'; i++) await closeGame(res.data.id, 5000);
        for (let i = 0; i < 40 && g && !out.ok && !g.finalized; i++) await sleep(500);
        // 玩家看到的两处：崩溃弹窗（g.crash.reasons）和详细分析（troubleshoot:analyze）
        const issues = g ? await c.bus.call('troubleshoot:analyze', 'CrashP', res.data.id) : null;
        text = `${JSON.stringify(out).slice(0, 160)} 弹窗：${JSON.stringify((g && g.crash && g.crash.reasons) || [])} 分析：${JSON.stringify(((issues && issues.data) || []).map((i) => i.title))}`;
        if (g && g.state !== 'exited') await killAll();
      }
      console.log(`  ${label}：${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
      check('real', `崩溃分析：${label}`, want.test(text), String(text).slice(0, 300));
    };
    await fakeFabricMod(path.join(mods, 'needs-missing.jar'), 'needs_missing', { depends: { totally_missing_mod: '*' } });
    await run('缺前置 Mod：弹窗和分析都说得出缺什么', /弹窗：\[[^\]]*(前置|totally_missing_mod)[^\]]*\] 分析：\[[^\]]*totally_missing_mod/);
    await fsp.rm(path.join(mods, 'needs-missing.jar'));
    await fakeFabricMod(path.join(mods, 'dup-a.jar'), 'dup_mod');
    await fakeFabricMod(path.join(mods, 'dup-b.jar'), 'dup_mod');
    // 同一个版本的同一个 Mod 放两份，Fabric 只加载一份，游戏照常能进，不算问题
    await run('同一个 Mod 放两份：Fabric 自己去重，游戏能进', /"ok":true/);
    await fsp.rm(path.join(mods, 'dup-a.jar')); await fsp.rm(path.join(mods, 'dup-b.jar'));
    await fakeFabricMod(path.join(mods, 'breaks-fabric.jar'), 'breaks_it', { breaks: { fabricloader: '*' } });
    await run('声明不兼容：弹窗和分析都说得出谁不兼容', /弹窗：\[[^\]]*(不兼容|breaks_it)[^\]]*\] 分析：\[[^\]]*breaks_it/);
    await killAll();
  },

  /** Mod 配置器：走界面的流程（推荐 → 解析 → 安装），装出来的配置真的进世界 */
  async planner() {
    const c = await common('real-planner');
    const styles = ['performance', 'qol']; // 配置器页面默认选的
    const rec = await c.bus.call('planner:recommend', { mc: MC, loader: 'fabric', styles });
    const raw = rec.ok ? (rec.data.items || rec.data.mods || rec.data || []) : [];
    const items = (Array.isArray(raw) ? raw : []).map((x) => ({ ...x, selected: x.selected !== false }));
    check('planner', `推荐出了 Mod（默认的「性能」「体验」）`, items.length > 0, rec.ok ? `${items.length} 个` : rec.error);
    if (!items.length) return;
    const res = await c.bus.call('planner:resolve', { mc: MC, loader: 'fabric', items });
    check('planner', '解析出了能下载的版本和前置', res.ok && (res.data.items || []).some((i) => i.status === 'ok'), res.ok ? { ok: res.data.items.filter((i) => i.status === 'ok').length, other: res.data.items.filter((i) => i.status !== 'ok').map((i) => `${i.slug || i.title}:${i.status}`).slice(0, 12) } : res.error);
    if (!res.ok) return;
    const plan = { id: 'real-plan', name: 'PlannerReal', mc: MC, loader: 'fabric', styles, items };
    const t0 = Date.now();
    const r = await c.bus.call('planner:install', { plan, resolved: res.data, target: { mode: 'new', name: 'PlannerReal' } });
    check('planner', '开始安装', r.ok, r.error || '');
    if (!r.ok) return;
    const tasks = core('tasks');
    const end = Date.now() + 900000;
    let t = null;
    while (Date.now() < end) { t = tasks.list().find((x) => x.id === r.data); if (t && t.status !== 'running') break; await sleep(500); }
    check('planner', `真实下载并装好（${Math.round((Date.now() - t0) / 1000)} 秒）`, t && t.status === 'done', t && { status: t.status, detail: String(t.detail).slice(0, 200) });
    if (!t || t.status !== 'done') return;
    const gd = c.versions.gameDirFor('PlannerReal', await c.versions.versionInfo('PlannerReal'));
    const jars = fs.readdirSync(path.join(gd, 'mods')).filter((n) => n.endsWith('.jar'));
    console.log(`  装了 ${jars.length} 个 Mod：${jars.slice(0, 12).join('、')}${jars.length > 12 ? '…' : ''}`);
    check('planner', 'Mod 都放进去了', jars.length > 0, jars.length);
    const w = await enterWorld(c, 'PlannerReal', 'PlannerWorld');
    const log = w.id ? lines(w.id).join('\n') : '';
    check('planner', '配置器装出来的配置真的进了世界', w.ok, w.ok ? '' : { why: w.why, tail: (w.tail || []).slice(-6) });
    const loaded = log.match(/Loading (\d+) mods/);
    check('planner', '日志里 Fabric 加载了这些 Mod', !!loaded && Number(loaded[1]) >= jars.length, loaded && loaded[0]);
    if (w.ok) { await sleep(6000); console.log(`  游戏截图不是黑屏的采样点：${await shotGame(w.id, 'planner-world')}`); await closeGame(w.id); } // pitfall-ok：截图前让游戏画面画出来（只打印采样点，不判断）
    await killAll();
  },

  /** 启动器外面开的游戏（清单 6-2）：真的开一个游戏，然后让启动器当作不知道它（和关掉启动器再打开一样） */
  async external() {
    const c = await common('real-external');
    await makeProfile(c.game, 'ExtP');
    await makeProfile(c.game, 'OtherP');
    c.config.setVersionSettings('ExtP', { isolation: 'on' });
    c.config.setVersionSettings('OtherP', { isolation: 'on' });
    await c.profiles.writeMeta('ExtP', { type: 'vanilla' });
    await c.profiles.writeMeta('OtherP', { type: 'vanilla' });
    const w = await enterWorld(c, 'ExtP', 'ExtWorld');
    check('6-2', '真的进了世界', w.ok, w.ok ? '' : w);
    if (!w.ok) { await killAll(); return; }
    await waitFor(() => fs.existsSync(path.join(w.gd, 'saves', 'ExtWorld', 'session.lock')), 30000);
    const launcher = core('launcher');
    const gamelock = core('gamelock');
    const realList = launcher.listGames;
    launcher.listGames = () => [];
    const noGames = launcher.listGames().length === 0;
    const refused = async (label, run) => {
      const r = await run();
      check('6-2', `外面开着游戏时拦下：${label}`, !r.ok && /游戏/.test(r.error || ''), r.ok ? '没有拦下来' : r.error);
    };
    const saves = path.join(w.gd, 'saves');
    await refused('删除这个配置', () => c.bus.call('versions:remove', 'ExtP', {}));
    await refused('重命名这个配置', () => c.bus.call('versions:rename', 'ExtP', 'ExtP2'));
    await refused('换数据存储位置', () => c.bus.call('location:switch', { mode: 'default' }));
    const forOther = await gamelock.forVersion('OtherP');
    check('6-2', '别的配置不受影响', !forOther, forOther);
    const byPath = await gamelock.forPath(saves);
    check('6-2', '按目录也认得出来', !!byPath && byPath.external === true, byPath && { external: byPath.external, versionId: byPath.versionId });
    check('6-2', '认出了版本名，没有把登录令牌留下来', byPath && byPath.versionId === 'ExtP' && !JSON.stringify(byPath).includes('accessToken'), byPath && Object.keys(byPath));
    // 查不了进程（被策略禁用 PowerShell、杀毒软件拦了）：世界开着时还能靠 session.lock 认出来
    const cp = require('child_process');
    const realExec = cp.execFile;
    cp.execFile = (cmd, args, opts, cb) => (/tasklist|powershell/i.test(cmd) ? setImmediate(() => cb(new Error('被拦了（模拟）'), '', '')) : realExec(cmd, args, opts, cb));
    await sleep(5200); // 等缓存过期 // pitfall-ok：等占用查询的 5 秒缓存过期：要的是不走缓存的那一次
    const lockOnly = await gamelock.forPath(saves);
    check('6-2', '查不了进程时：session.lock 拿不到，也认得出来', !!lockOnly && !!lockOnly.world, lockOnly && lockOnly.world && path.basename(lockOnly.world));
    const del = await c.bus.call('versions:remove', 'ExtP', {});
    check('6-2', '查不了进程时：删配置也拦下了', !del.ok && /占着/.test(del.error || ''), del.ok ? '没有拦下来' : del.error);
    cp.execFile = realExec;
    launcher.listGames = realList;
    check('6-2', '配置还在，世界还在', fs.existsSync(path.join(saves, 'ExtWorld', 'level.dat')) && noGames);
    await closeGame(w.id);
    await killAll();
    await waitFor(async () => !(await gamelock.forPath(saves)), 20000);
    const after = await gamelock.forPath(saves);
    check('6-2', '游戏关了以后：不再拦', !after, after);
    await sleep(5200); // pitfall-ok：等占用查询的 5 秒缓存过期：要的是不走缓存的那一次
    const t0 = Date.now();
    await gamelock.forPath(saves);
    console.log(`  没有游戏时查一次占用：${Date.now() - t0} ms`);
  },

  /** 子进程编码（清单 8-4）：JVM 启动前的报错是系统编码，路径带中文时不能是乱码 */
  async 'jvm-encoding'() {
    const c = await common('real-encoding');
    await makeProfile(c.game, 'EncP');
    const gd = c.versions.versionDir('EncP');
    await writeOptions(gd);
    const bad = path.join(gd, '中文 日志 目录', '不存在', 'y.log');
    c.config.setVersionSettings('EncP', { jvmArgs: `-Xlog:gc:file="${bad}"` });
    const r = await c.bus.call('launch:start', 'EncP', {});
    if (!r.ok) { check('8-4', '启动', false, r.error); return; }
    const launcher = core('launcher');
    await launcher.waitOutcome(r.data.id, { timeout: 60000 });
    const g = launcher.getGame(r.data.id);
    const text = g.lines.map((l) => l.text).join('\n');
    const line = g.lines.map((l) => l.text).filter((l) => /y\.log/.test(l) && !/^\[Aurora\]/.test(l))[0] || '';
    console.log(`  JVM 报错：${line.replace(/[A-Z]:\\\S*?(中文|�)/, '<路径>$1').slice(0, 160)}`);
    check('8-4', 'JVM 启动前的报错：路径里的中文不是乱码', /中文 日志 目录/.test(line) && !/\ufffd/.test(line), line.slice(-60));
    check('8-4', '后面 UTF-8 的日志也没被影响', /\[Aurora\] 启动 EncP/.test(text));
    await killAll();
  },

  /** 版本名带分号（清单 10-4）：以前校验放行，真启动会怎样；现在建不出来，老的配置启动时说清楚 */
  async semicolon() {
    const c = await common('real-semicolon');
    await makeProfile(c.game, 'Semi;Colon');
    const gd = c.versions.versionDir('Semi;Colon');
    await writeOptions(gd);
    await makeWorld(path.join(gd, 'saves'), 'SemiWorld');
    c.config.setVersionSettings('Semi;Colon', { gameArgs: '--quickPlaySingleplayer SemiWorld' });
    const r = await c.bus.call('launch:start', 'Semi;Colon', {});
    if (!r.ok) {
      check('10-4', '老的带分号的配置：启动时说清楚原因', /分号|改个名|改名/.test(r.error || ''), r.error);
      return;
    }
    const w = await waitInWorld('Semi;Colon', r.data.id, 180000);
    const g = core('launcher').getGame(r.data.id);
    const tail = g ? g.lines.slice(-4).map((l) => l.text.slice(0, 160)) : [];
    check('10-4', '老的带分号的配置：要么能进游戏，要么启动前说清楚', w.ok, { why: w.why, tail });
    await killAll();
  },

  /** 老版本：1.12.2、1.8.9（自动下载 Java 8），到主菜单 */
  async old() {
    const c = await common('real-old');
    c.config.set({ java: { selected: 'auto', autoDownload: true } });
    for (const mc of ['1.12.2', '1.8.9']) {
      const t0 = Date.now();
      const r = await installWait(c.bus, { mc, name: mc, asProfile: true });
      check('real', `${mc}：真实安装成功（${Math.round((Date.now() - t0) / 1000)} 秒）`, r.ok, r.error || '');
      if (!r.ok) continue;
      await writeOptions(c.versions.gameDirFor(mc, await c.versions.versionInfo(mc)));
      const res = await c.bus.call('launch:start', mc, {});
      if (!res.ok) { check('real', `${mc}：能启动`, false, res.error); continue; }
      const end = Date.now() + 240000;
      let ok = false;
      while (Date.now() < end && !ok) {
        const g = core('launcher').getGame(res.data.id);
        if (!g || g.state === 'exited') break;
        ok = g.lines.some((x) => /Sound engine started|SoundSystem|Created: \d+x\d+|LWJGL Version|OpenAL initialized/i.test(x.text));
        await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
      }
      check('real', `${mc}：启动到主菜单（Java 8）`, ok, ok ? '' : lines(res.data.id).slice(-4));
      await sleep(3000); // pitfall-ok：截图前让游戏画面画出来（只打印采样点，不判断）
      if (ok) console.log(`  游戏截图不是黑屏的采样点：${await shotGame(res.data.id, `old-${mc}`)}`);
      await closeGame(res.data.id, 30000);
      await killAll();
    }
  },

  /** 整合包：手工做一个 mrpack（Fabric + Sodium），从文件安装，能玩 */
  async pack() {
    const c = await common('real-pack');
    const list = await c.bus.call('loaders:list', 'fabric', MC);
    const ver = ((list.data || []).find((x) => x.stable) || (list.data || [])[0]).version;
    const [api, sodium] = await Promise.all([modrinthFile('fabric-api', 'fabric'), modrinthFile('sodium', 'fabric')]);
    const entry = (f) => ({ path: `mods/${f.filename}`, hashes: { sha1: f.sha1, sha512: f.sha512 }, env: { client: 'required', server: 'required' }, downloads: [f.url], fileSize: f.size });
    const { ZipWriter } = core('zip');
    const packFile = path.join(c.root, '测试 整合包.mrpack');
    const z = await ZipWriter.create(packFile);
    const idx = Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: '测试 整合包', files: [entry(api), entry(sodium)], dependencies: { minecraft: MC, 'fabric-loader': ver } }));
    await z.addBuffer('modrinth.index.json', idx);
    await z.close();
    const r = await c.bus.call('modpack:installFile', packFile, '测试 整合包', {});
    check('real', '整合包：开始安装', r.ok, r.error || '');
    if (!r.ok) return;
    const tasks = core('tasks');
    const end = Date.now() + 600000;
    let st = null;
    while (Date.now() < end) { st = tasks.list().find((t) => t.id === r.data); if (st && st.status !== 'running') break; await sleep(1000); }
    check('real', '整合包：从文件装好了', st && st.status === 'done', st && st.detail);
    if (!st || st.status !== 'done') return;
    const w = await enterWorld(c, '测试 整合包', 'PackWorld');
    const log = w.id ? lines(w.id).join('\n') : '';
    check('real', '整合包：真的进了世界，Sodium 加载了', w.ok && /sodium/i.test(log), w.ok ? '' : { why: w.why, tail: w.tail });
    if (w.ok) await closeGame(w.id);
    await killAll();
  },

  /** 设置同步：同步的按键写进目标配置，游戏跑过一次还在（游戏读不懂的话退出时会改掉） */
  async sync() {
    const c = await common('real-sync');
    for (const id of ['SyncA', 'SyncB']) { await makeProfile(c.game, id); c.config.setVersionSettings(id, { isolation: 'on' }); await c.profiles.writeMeta(id, { type: 'vanilla' }); }
    const a = c.versions.versionDir('SyncA'); const b = c.versions.versionDir('SyncB');
    await fsp.writeFile(path.join(a, 'options.txt'), 'version:3465\nkey_key.jump:key.keyboard.j\nsoundCategory_master:0.3\nrenderDistance:7\nonboardAccessibility:false\n');
    await fsp.writeFile(path.join(b, 'options.txt'), 'version:3465\nkey_key.jump:key.keyboard.space\nsoundCategory_master:1.0\nrenderDistance:12\nonboardAccessibility:false\npauseOnLostFocus:false\n');
    const r = await c.bus.call('gamesync:copyTo', 'SyncA', ['SyncB'], null);
    check('real', '设置同步：同步到目标配置', r.ok, r.error || '');
    const after = fs.readFileSync(path.join(b, 'options.txt'), 'utf8');
    check('real', '设置同步：按键、音量、视距写进去了', /key_key\.jump:key\.keyboard\.j/.test(after) && /renderDistance:7/.test(after) && /soundCategory_master:0\.3/.test(after), after.slice(0, 200));
    c.config.setVersionSettings('SyncB', { gameArgs: '--quickPlaySingleplayer SyncWorld' });
    await makeWorld(path.join(b, 'saves'), 'SyncWorld');
    const res = await c.bus.call('launch:start', 'SyncB', {});
    const w = res.ok ? await waitInWorld('SyncB', res.data.id, 300000) : { ok: false, why: res.error };
    check('real', '设置同步：游戏能进世界', w.ok, w.ok ? '' : w);
    if (res.ok) await closeGame(res.data.id);
    const last = fs.readFileSync(path.join(b, 'options.txt'), 'utf8');
    check('real', '设置同步：游戏跑过以后设置还在（游戏真的读进去了）', /key_key\.jump:key\.keyboard\.j/.test(last) && /renderDistance:7/.test(last), last.split('\n').filter((l) => /jump|renderDistance/.test(l)));
    await killAll();
  },

  /** 外置登录：本地模拟 Yggdrasil，登录、错密码、刷新、失效；authlib-injector 真的连上它，进世界 */
  async ygg() {
    const c = await common('real-ygg');
    const mock = await yggMock();
    try {
      const accounts = core('auth/accounts');
      const bad = await accounts.yggLogin({ server: mock.url, username: 'a@b.c', password: 'wrong' }).then(() => null, (e) => e.message);
      check('account', '密码错：看得懂的提示', !!bad && !/Exception/.test(bad), bad);
      const acc = (await accounts.yggLogin({ server: mock.url, username: 'a@b.c', password: 'right-password' })).account;
      check('account', '外置登录成功，角色名对', acc && acc.name === 'MockPlayer', acc && { name: acc.name, type: acc.type });
      const stored = fs.readFileSync(path.join(c.data, 'accounts.json'), 'utf8');
      check('account', '令牌没有明文写进账户文件', !stored.includes(mock.state.token), stored.includes(mock.state.token) ? '明文' : '');
      // 令牌过期：启动前自动刷新
      mock.state.token = 'server-side-new';
      await makeProfile(c.game, 'YggP');
      c.config.setVersionSettings('YggP', { isolation: 'on' });
      await c.profiles.writeMeta('YggP', { type: 'vanilla' });
      const sel = await c.bus.call('accounts:select', acc.id);
      const w = await enterWorld(c, 'YggP', 'YggWorld');
      const log = w.id ? lines(w.id).join('\n') : '';
      console.log(`  模拟服务器收到：${[...new Set(mock.state.requests)].join('，').slice(0, 300)}`);
      check('account', '令牌失效时启动前自动刷新', mock.state.refreshed >= 1, { refreshed: mock.state.refreshed, select: sel.ok });
      check('account', '游戏带着外置登录进了世界', w.ok, w.ok ? '' : { why: w.why, tail: w.tail });
      check('account', 'authlib-injector 真的挂上了（启动器把服务器信息预先给它，不会再请求根地址）', /\[authlib-injector\]/i.test(log), log.split('\n').filter((l) => /authlib/i.test(l)).slice(0, 2).map((l) => l.replace(/[A-Z]:\\\S+/g, '<路径>')));
      check('account', '游戏取了这个角色的皮肤', mock.state.requests.some((x) => /session\/minecraft\/profile/.test(x)), [...new Set(mock.state.requests)].filter((x) => /profile|textures/.test(x)));
      if (w.ok) await closeGame(w.id);
      await killAll();
      // 刷新也失败：提示重新登录，不是崩掉
      mock.state.token = 'gone'; mock.state.invalid = 'refresh';
      const r = await c.bus.call('launch:start', 'YggP', {});
      check('account', '令牌彻底失效：启动被拦下，提示重新登录', !r.ok && /登录/.test(r.error || ''), r.ok ? '竟然启动了' : r.error);
      if (r.ok) await killAll();
    } finally { await mock.close(); }
  },

  /** 微软登录：本地模拟整条链路（设备码、Xbox、XSTS、Minecraft），真账号不碰 */
  async ms() {
    const dirs = setup('real-ms');
    const config = core('config');
    const msMod = core('auth/microsoft');
    config.set({ setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, msClientId: '' });
    const st = { calls: [], dcBodies: [] };
    const undo = msMock(st);
    try {
      const accounts = core('auth/accounts');
      const dcDef = await accounts.msStart();
      check('account', '微软：未填自定义 Client ID 时自动使用内置默认 Client ID', dcDef && /ABCD/.test(dcDef.userCode || '') && (st.dcBodies[0] || '').includes(`client_id=${msMod.DEFAULT_CLIENT_ID}`), st.dcBodies[0]);
      accounts.msCancel();
      config.set({ msClientId: 'test-client' });
      const dc = await accounts.msStart();
      check('account', '微软：配置了自定义 Client ID 时优先使用自定义值', dc && /ABCD/.test(dc.userCode || JSON.stringify(dc)) && (st.dcBodies[1] || '').includes('client_id=test-client'), st.dcBodies[1]);
      const steps = [];
      const acc = await accounts.msWait((s) => steps.push(s));
      const skins = core('skins');
      const lib = await skins.libraryAll();
      const legRaw = require('electron').nativeImage.createFromBitmap(Buffer.alloc(64 * 32 * 4, 255), { width: 64, height: 32 }).toPNG();
      const legNorm = skins.normalizeSkinBuffer(legRaw);
      check('account', '微软：走完设备码、Xbox、XSTS、Minecraft，账户存好了且 http 皮肤升成本地或 https', acc && acc.name === 'MsMock' && acc.type === 'microsoft' && acc.skin && !/^http:\/\//i.test(acc.skin.url) && /^file:/i.test(acc.skin.url), acc && { name: acc.name, type: acc.type, skin: acc.skin && acc.skin.url, steps: steps.length });
      check('account', '微软：正版皮肤自动保存到皮肤中心「正版账户皮肤」分组，旧版 64×32 可转成 64×64', lib.groups.includes(skins.MS_GROUP) && lib.items.some((x) => x.group === skins.MS_GROUP && x.name === 'MsMock') && legNorm && legNorm.legacy && skins.pngSize(legNorm.png).h === 64, { groups: lib.groups, items: lib.items.length, leg: legNorm && skins.pngSize(legNorm.png) });
      const file = fs.readFileSync(path.join(dirs.data, 'accounts.json'), 'utf8');
      check('account', '微软：令牌没有明文写进账户文件', !file.includes('ms-refresh') && !file.includes('ms-access'));
      const r = await accounts.refresh(acc.id);
      check('account', '微软：刷新令牌能用', !!r, st.calls.filter((x) => /token/.test(x)).length);
      // 账户记着签发它的 Client ID：设置里换回默认以后，刷新还用当初登录的那个
      config.set({ msClientId: '' });
      st.refreshBodies = [];
      await accounts.refresh(acc.id);
      check('account', '微软：刷新用的是登录这个账户时的 Client ID（设置里改了也不变）', accounts.raw().find((x) => x.id === acc.id).msClientId === 'test-client' && (st.refreshBodies[0] || '').includes('client_id=test-client'), st.refreshBodies[0]);
      // 同时刷新两次：合成一次请求（微软每次都换新的刷新令牌，两个请求拿同一个旧令牌会有一个失败）
      st.refreshBodies = []; st.refreshDelay = 300;
      const two = await Promise.all([accounts.refresh(acc.id), accounts.refresh(acc.id)]).then(() => 'ok', (e) => e.message);
      st.refreshDelay = 0;
      check('account', '微软：同一个账户同时刷新两次，只发一次刷新请求', two === 'ok' && st.refreshBodies.length === 1, { two, n: st.refreshBodies.length });
      // 微软那边暂时出错（503）：不要玩家重新登录；令牌快过期但还能用时照样能进游戏
      st.refreshFlaky = true;
      const flaky = await accounts.refresh(acc.id).then(() => null, (e) => e);
      const rawAcc = accounts.raw().find((x) => x.id === acc.id);
      check('account', '微软：刷新时服务器暂时出错（503），不标成要重新登录，提示稍后再试', !!flaky && !flaky.needRelogin && !rawAcc.needRelogin && /稍后再试/.test(flaky.message), flaky && flaky.message);
      const realExp = rawAcc.mcExpiresAt;
      rawAcc.mcExpiresAt = Date.now() + 5 * 60000; // 还有 5 分钟过期：会先刷新
      const steps2 = [];
      const auth = await accounts.getLaunchAuth(acc.id, (s) => steps2.push(s)).then((x) => x, (e) => e.message);
      check('account', '微软：快过期、刷新又暂时失败时，用手里还没过期的令牌照样能启动，并说一声', auth && auth.type === 'microsoft' && !!auth.accessToken && steps2.some((s) => /先用现有的登录/.test(s)), { auth: auth && auth.type ? auth.type : auth, steps2 });
      rawAcc.mcExpiresAt = Date.now() + 30000; // 只剩 30 秒：不能再用了，照常报错
      const expired = await accounts.getLaunchAuth(acc.id, () => {}).then(() => null, (e) => e.message);
      check('account', '微软：令牌马上就过期、刷新又失败时，不拿它启动，报出原因', !!expired && /稍后再试/.test(expired), expired);
      rawAcc.mcExpiresAt = realExp; st.refreshFlaky = false;
      // 等授权时点了取消：马上停，不用等完这一轮的间隔（以前要等上一轮 5 秒）
      st.dcInterval = 5; st.polls = 0;
      await accounts.msStart();
      const t1 = Date.now();
      const waiting = accounts.msWait(() => {}).then(() => 'logged-in', (e) => (e.cancelled ? 'cancelled' : e.message));
      await new Promise((res) => setTimeout(res, 200));
      accounts.msCancel();
      const cancelled = await waiting;
      check('account', '微软：等授权时取消，马上停下（1 秒内）', cancelled === 'cancelled' && Date.now() - t1 < 1200, { cancelled, ms: Date.now() - t1 });
      st.dcInterval = 0; config.set({ msClientId: 'test-client' });
      // 模拟旧版本升级导入后还没有 skinCache 的微软账户：导出不带 cache，重新导入后能立即升级 https 并后台补拉
      const exported = accounts.exportList();
      await accounts.remove(acc.id);
      await accounts.importList(exported);
      const preView = accounts.list().accounts.find((x) => x.id === acc.id);
      await accounts.syncMissingMicrosoftSkins();
      const postView = accounts.list().accounts.find((x) => x.id === acc.id);
      check('account', '微软：旧账户无本地缓存时先升 https，补拉后变成本地缓存且进入皮肤中心', preView && /^https:\/\//.test(preView.skin && preView.skin.url || '') && postView && /^file:\/\//.test(postView.skin && postView.skin.url || ''), { pre: preView && preView.skin, post: postView && postView.skin });
      // 已经同步过的：过了很久再列账户、开皮肤中心，也不再联网下皮肤（以前条件里多了个恒为真的「|| !null」，每分钟下一次）
      const texCalls = () => st.calls.filter((x) => /textures\.minecraft\.net/.test(x)).length;
      const tex0 = texCalls();
      const realNow = Date.now;
      Date.now = () => realNow() + 3600000;
      try { accounts.list(); await accounts.syncMissingMicrosoftSkins(); await skins.libraryAll(); await accounts.syncMissingMicrosoftSkins(); } finally { Date.now = realNow; }
      check('account', '微软：已经同步过的皮肤，一小时后再列账户、开皮肤中心也不重新下载', texCalls() === tex0, { before: tex0, after: texCalls() });
      // 再同步一次（重新登录、刷新时会同步）：皮肤中心里这张留在原来的位置，不被挪到最前面
      const other = require('electron').nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 200), { width: 64, height: 64 }).toPNG();
      await skins.libraryAdd({ png: other, model: 'classic', name: '后加的皮肤' });
      const order0 = (await skins.libraryAll()).items.map((x) => x.name);
      await accounts.syncMicrosoftSkin(accounts.raw().find((x) => x.id === acc.id));
      const order1 = (await skins.libraryAll()).items.map((x) => x.name);
      check('account', '微软：再同步一次，皮肤中心里正版皮肤的位置不变', order0[0] === '后加的皮肤' && JSON.stringify(order0) === JSON.stringify(order1), { order0, order1 });
      // 打开皮肤中心不等补拉：有个账户要补拉、而且网很慢（8 秒）时，皮肤中心照样马上打开
      const bus = ipc();
      const exported2 = accounts.exportList();
      await accounts.remove(acc.id);
      await accounts.importList(exported2);
      st.texDelay = 8000;
      const t0 = realNow();
      const libR = await bus.call('skins:libraryAll');
      const took = realNow() - t0;
      check('account', '微软：有账户要补拉皮肤、网又很慢时，打开皮肤中心不用等下载（2 秒内）', libR && libR.ok !== false && took < 2000, { took, ok: libR && libR.ok });
      await waitFor(() => texCalls() > tex0, 5000);
      await waitFor(async () => { const v = accounts.list().accounts.find((x) => x.id === acc.id); return v && /^file:/.test((v.skin && v.skin.url) || ''); }, 20000);
      st.texDelay = 0;
      const after2 = accounts.list().accounts.find((x) => x.id === acc.id);
      check('account', '微软：后台补拉完成后皮肤变成本地缓存', after2 && /^file:/.test((after2.skin && after2.skin.url) || ''), after2 && after2.skin);
      st.refreshBad = true;
      const bad = await accounts.refresh(acc.id).then(() => null, (e) => e.message);
      check('account', '微软：刷新令牌过期，提示重新登录', !!bad && /登录/.test(bad), bad);
      st.refreshBad = false;
      st.noGame = true; st.polls = 0;
      await accounts.msStart();
      const noGame = await accounts.msWait(() => {}).then(() => null, (e) => e.message);
      check('account', '微软：账号没买游戏，提示看得懂', !!noGame && /[一-鿿]/.test(noGame), noGame);
      st.noGame = false; st.noXbox = true; st.polls = 0;
      await accounts.msStart();
      const noXbox = await accounts.msWait(() => {}).then(() => null, (e) => e.message);
      check('account', '微软：没有 Xbox 档案，提示看得懂', !!noXbox && /Xbox|XSTS|[一-鿿]/.test(noXbox), noXbox);
      check('account', '微软：没有连到真的微软服务器（都走本地模拟）', st.calls.length > 5, [...new Set(st.calls)].slice(0, 6));
    } finally { undo(); }
  },
};

(async () => {
  await app.whenReady();
  const name = process.argv[process.argv.length - 1];
  if (!SCENARIOS[name]) { console.log(`场景：${Object.keys(SCENARIOS).join(' ')}`); finish(2); return; }
  if (name !== 'ms' && (!SRC || !JAVA)) { check('real', '没跑：缺环境变量 AURORA_REGRESS_GAME_SRC / AURORA_REGRESS_JAVA_HOME（没跑不能算通过）', false); finish(2); return; }
  try {
    await SCENARIOS[name]();
  } catch (e) {
    check(name, '脚本运行出错', false, e.stack || String(e));
    await killAll().catch(() => {});
  }
  finish();
})();
