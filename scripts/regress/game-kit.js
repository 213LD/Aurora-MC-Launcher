'use strict';
/**
 * 真实启动游戏的公用部分（game-locks.js、game-real.js）。
 *   AURORA_REGRESS_GAME_SRC   一个装好 1.20.1 的游戏目录（有 libraries、assets、versions/1.20.1），只读，会复制一份
 *   AURORA_REGRESS_JAVA_HOME  Java 17 的目录（有 bin/javaw.exe），只读，会复制到隔离数据目录的 runtime 里
 * 用手工做的超平坦世界 + --quickPlaySingleplayer 直接进世界，游戏才真的占着 session.lock 和区域文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const H = require('./harness');

const { sleep, waitFor, setup, core, ipc } = H;
const SRC = process.env.AURORA_REGRESS_GAME_SRC;
const JAVA = process.env.AURORA_REGRESS_JAVA_HOME;
const MC = '1.20.1';

function makeLevelDat(name) {
  const nbt = core('nbt');
  const { T } = nbt;
  const s = (v) => ({ type: T.STRING, value: v });
  const i = (v) => ({ type: T.INT, value: v });
  const b = (v) => ({ type: T.BYTE, value: v });
  const l = (v) => ({ type: T.LONG, value: BigInt(v) });
  const c = (v) => ({ type: T.COMPOUND, value: v });
  const list = (type, items) => ({ type: T.LIST, value: { type, items } });
  const layer = (block, height) => ({ block: s(block), height: i(height) });
  const dim = (type, generator) => c({ type: s(type), generator: c(generator) });
  const flat = { type: s('minecraft:flat'), settings: c({ biome: s('minecraft:plains'), lakes: b(0), features: b(0), layers: list(T.COMPOUND, [layer('minecraft:bedrock', 1), layer('minecraft:stone', 3)]), structure_overrides: list(T.END, []) }) };
  const noise = (settings, preset) => ({ type: s('minecraft:noise'), settings: s(settings), biome_source: c({ type: s('minecraft:multi_noise'), preset: s(preset) }) });
  const data = c({
    DataVersion: i(3465), version: i(19133),
    Version: c({ Id: i(3465), Name: s(MC), Series: s('main'), Snapshot: b(0) }),
    LevelName: s(name), GameType: i(1), Difficulty: b(0), DifficultyLocked: b(0), hardcore: b(0), allowCommands: b(1), initialized: b(0),
    LastPlayed: l(Date.now()), Time: l(0), DayTime: l(6000), SpawnX: i(0), SpawnY: i(5), SpawnZ: i(0),
    DataPacks: c({ Enabled: list(T.STRING, ['vanilla']), Disabled: list(T.END, []) }),
    GameRules: c({}),
    WorldGenSettings: c({
      bonus_chest: b(0), generate_features: b(0), seed: l(12345),
      dimensions: c({
        'minecraft:overworld': dim('minecraft:overworld', flat),
        'minecraft:the_nether': dim('minecraft:the_nether', noise('minecraft:nether', 'minecraft:nether')),
        'minecraft:the_end': dim('minecraft:the_end', { type: s('minecraft:noise'), settings: s('minecraft:end'), biome_source: c({ type: s('minecraft:the_end') }) }),
      }),
    }),
  });
  return zlib.gzipSync(nbt.serialize({ name: '', value: { Data: data } }));
}

async function makeWorld(savesDir, name) {
  const dir = path.join(savesDir, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'level.dat'), makeLevelDat(name));
  return dir;
}

/** 关声音、跳过第一次启动的辅助功能页、小窗口：测试时不打扰人 */
async function writeOptions(gameDir) {
  await fsp.mkdir(gameDir, { recursive: true });
  await fsp.writeFile(path.join(gameDir, 'options.txt'), 'onboardAccessibility:false\nsoundCategory_master:0.0\nsoundCategory_music:0.0\npauseOnLostFocus:false\nlang:en_us\n');
}

async function prepareGame(game, data) {
  for (const d of ['libraries', 'assets']) await fsp.cp(path.join(SRC, d), path.join(game, d), { recursive: true });
  await fsp.cp(path.join(SRC, 'versions', MC), path.join(game, 'versions', MC), { recursive: true });
  await fsp.cp(JAVA, path.join(data, 'runtime', 'regress-java'), { recursive: true });
}

/** 配置 = 原版 JSON 复制一份换名字（jar 也复制，1.20.1 原版不继承） */
async function makeProfile(game, id) {
  const dir = path.join(game, 'versions', id);
  await fsp.mkdir(dir, { recursive: true });
  const json = JSON.parse(await fsp.readFile(path.join(game, 'versions', MC, `${MC}.json`), 'utf8'));
  json.id = id;
  json.clientVersion = MC;
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(json));
  await fsp.copyFile(path.join(game, 'versions', MC, `${MC}.jar`), path.join(dir, `${id}.jar`));
  return dir;
}

async function waitInWorld(id, gameId, timeoutMs = 240000) {
  const launcher = core('launcher');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const g = launcher.getGame(gameId);
    if (!g || g.state === 'exited') return { ok: false, why: `游戏退出了（代码 ${g && g.exitCode}）`, tail: g ? g.lines.slice(-12).map((x) => x.text) : [] };
    if (g.lines.some((x) => /joined the game|logged in with entity id/.test(x.text))) return { ok: true };
    await sleep(1000); // pitfall-ok：轮询里两次查看之间的间隔
  }
  const g = launcher.getGame(gameId);
  return { ok: false, why: '等进世界超时', tail: g ? g.lines.slice(-12).map((x) => x.text) : [] };
}

async function killAll() {
  const launcher = core('launcher');
  for (const g of launcher.listGames()) if (g.state !== 'exited') launcher.kill(g.id);
  for (let i = 0; i < 40 && launcher.running(); i++) await sleep(500);
  await waitFor(() => !core('tasks').list().some((t) => t.status === 'running'), 15000);
}

async function common(name) {
  const dirs = setup(`game-${name}`);
  await prepareGame(dirs.game, dirs.data);
  const config = core('config');
  config.set({ setupDone: true, disclaimerAccepted: require('./editions').DISCLAIMER, isolation: 'modded', java: { selected: path.join(dirs.data, 'runtime', 'regress-java', 'bin', 'java.exe'), autoDownload: false }, window: { width: 854, height: 480, fullscreen: false }, backup: { beforeLaunch: false }, autoChinese: false });
  const bus = ipc();
  await core('auth/accounts').addOffline('RegressPlayer');
  return { ...dirs, bus, config, versions: core('versions'), profiles: core('profiles'), isolation: core('isolation') };
}

module.exports = { SRC, JAVA, MC, makeLevelDat, makeWorld, writeOptions, prepareGame, makeProfile, waitInWorld, killAll, common };
