'use strict';
/**
 * 读 Mod 信息的对照表测试（rc12）。electron scripts/regress/modmeta-unit.js all（npm test 里跑）
 *
 * core/mods.js 的 metaFromZip 一个函数里读四种格式（Fabric、Quilt、Forge / NeoForge 的 mods.toml、老 Forge 的 mcmod.info），
 * 一百多个分支，JSON 和 TOML 都是自己写的宽松解析。依赖检查、冲突检查、一键 Debug、「需要更高版本的 Java」全靠它读出来的东西，
 * 以前却只有「坏文件不崩」的测试（robust.js），没有「读得对不对」的测试。
 * 这里真的打出 jar（内容照着真实 Mod 的写法：Forge 官方模板带的行尾注释、多行简介、两种引号……），读出来和期望的逐项比。
 * 不联网、不开窗口，几秒钟。
 */
const path = require('path');
const { app } = require('electron');
const H = require('./harness');

const { setup, core, check, finish } = H;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Java class 文件头：CAFEBABE + 次版本 + 主版本（主版本 - 44 = Java 版本）
const classOf = (java) => Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, java + 44, 0, 0]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

app.whenReady().then(async () => {
  const { root } = setup('modmeta');
  const mods = core('mods');
  const { ZipWriter } = core('zip');
  let n = 0;
  /** 打一个 jar：files 是 { 包里的路径: 文字或 Buffer }；返回文件路径 */
  const jar = async (files) => {
    const f = path.join(root, `m${n++}.jar`);
    const z = await ZipWriter.create(f);
    for (const [name, data] of Object.entries(files)) await z.addBuffer(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    await z.close();
    return f;
  };
  /** 包里再套一个 jar */
  const inner = async (files) => require('fs').promises.readFile(await jar(files));
  /** 一项：打 jar、读、挑出要看的几样、和期望的比 */
  const cases = [];
  const one = (name, files, pick, want) => cases.push({ name, files, pick, want });
  const sec = (m, loader) => (m.byLoader[loader] || {});

  // ── Fabric ──
  one('Fabric：常见写法（作者有的是字符串有的是对象、图标按尺寸给、依赖值有的是一个范围有的是几个里任选）', {
    'fabric.mod.json': JSON.stringify({
      schemaVersion: 1, id: 'examplemod', version: '1.4.2+1.20.1', name: 'Example Mod', description: '一个示例',
      authors: ['Alice', { name: 'Bob', contact: { homepage: 'https://example.com' } }], icon: { 16: 'assets/examplemod/icon16.png', 128: 'assets/examplemod/icon.png' },
      environment: 'client', entrypoints: { client: ['com.example.Client::init', { adapter: 'kotlin', value: 'com.example.KtEntry' }] },
      depends: { fabricloader: '>=0.14.21', minecraft: ['>=1.20 <1.20.3', '1.21'], 'fabric-api': '*', java: '>=17' },
      breaks: { optifabric: '*' }, conflicts: { sodium: '<0.5.0' }, provides: ['example-api'],
    }),
    'assets/examplemod/icon.png': png, 'com/example/Client.class': classOf(21),
  }, (m) => ({ id: m.id, name: m.name, version: m.version, authors: m.authors, loader: m.loader, loaders: m.loaders, ids: m.ids, provides: m.provides, env: m.env, deps: sec(m, 'fabric').deps, breaks: sec(m, 'fabric').breaks, conflicts: sec(m, 'fabric').conflicts, mc: sec(m, 'fabric').mc, icon: /^data:image\/png;base64,/.test(m.icon || ''), classJava: m.classJava }),
  { id: 'examplemod', name: 'Example Mod', version: '1.4.2+1.20.1', authors: ['Alice', 'Bob'], loader: 'fabric', loaders: ['fabric'], ids: ['examplemod'], provides: ['example-api'], env: 'client',
    deps: { fabricloader: ['>=0.14.21'], minecraft: ['>=1.20 <1.20.3', '1.21'], 'fabric-api': ['*'], java: ['>=17'] }, breaks: { optifabric: ['*'] }, conflicts: { sodium: ['<0.5.0'] }, mc: { kind: 'semver', ranges: ['>=1.20 <1.20.3', '1.21'] }, icon: true, classJava: 21 });

  one('Fabric：简介里直接换行、带制表符（不合规的 JSON，很多 Mod 这么写）照样读得出', {
    'fabric.mod.json': '{\n  "schemaVersion": 1,\n  "id": "multiline",\n  "version": "2.0",\n  "description": "第一行\n第二行\t带制表符",\n  "depends": { "minecraft": "1.20.1" }\n}',
  }, (m) => ({ id: m.id, version: m.version, name: m.name, desc: m.description, mc: sec(m, 'fabric').mc }),
  { id: 'multiline', version: '2.0', name: 'multiline', desc: '第一行\n第二行\t带制表符', mc: { kind: 'semver', ranges: ['1.20.1'] } });

  one('Fabric：包里套着的 jar（jars 字段）提供的 Mod 也算进「已提供」，它们要的游戏版本单独记', async () => ({
    'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'outer', version: '1.0', jars: [{ file: 'META-INF/jars/lib-1.0.jar' }], depends: { minecraft: '>=1.20' } }),
    'META-INF/jars/lib-1.0.jar': await inner({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'lib', version: '1.0', provides: ['lib-api'], depends: { minecraft: '~1.20.1' } }) }),
  }), (m) => ({ ids: m.ids, provides: m.provides, nested: sec(m, 'fabric').nestedMc }),
  { ids: ['outer'], provides: ['lib', 'lib-api'], nested: [{ kind: 'semver', ranges: ['~1.20.1'] }] });

  // ── Quilt ──
  one('Quilt：依赖有的只写名字、有的带版本、有的标了可选；版本可以是「任选其一」「都要满足」的对象', {
    'quilt.mod.json': JSON.stringify({ schema_version: 1, quilt_loader: {
      group: 'com.example', id: 'quiltmod', version: '3.1.0', metadata: { name: 'Quilt Mod', description: 'q', contributors: { Carol: 'Owner', Dave: 'Artist' }, icon: 'icon.png' },
      depends: ['quilt_base', { id: 'minecraft', versions: '>=1.20' }, { id: 'optionaldep', versions: '*', optional: true }, { id: 'qsl', versions: { any: ['>=6.0.0', '5.x'] } }, { id: 'both', versions: { all: ['>=1.0', '<2.0'] } }, { id: 'listed', versions: ['1.x', '2.x'] }],
      breaks: ['badmod', { id: 'oldmod', versions: '<1.0' }], provides: ['alias', { id: 'alias2', version: '1.0' }],
    } }),
  }, (m) => ({ id: m.id, name: m.name, version: m.version, authors: m.authors, loader: m.loader, ids: m.ids, provides: m.provides, deps: sec(m, 'quilt').deps, breaks: sec(m, 'quilt').breaks, mc: sec(m, 'quilt').mc }),
  { id: 'quiltmod', name: 'Quilt Mod', version: '3.1.0', authors: ['Carol', 'Dave'], loader: 'quilt', ids: ['quiltmod'], provides: ['alias', 'alias2'],
    deps: { quilt_base: ['*'], minecraft: ['>=1.20'], qsl: ['>=6.0.0', '5.x'], both: ['>=1.0 <2.0'], listed: ['1.x', '2.x'] }, breaks: { badmod: ['*'], oldmod: ['<1.0'] }, mc: { kind: 'semver', ranges: ['>=1.20'] } });

  // ── Forge ──
  // 照 Forge 官方模板（MDK）的写法：表头后面带注释、版本号是占位符、简介是多行、键两边空格不一
  const MDK = [
    'modLoader="javafml" #mandatory', 'loaderVersion="[47,)" #mandatory', 'license="MIT"', '#issueTrackerURL="https://example.com/issues" #optional',
    '[[mods]] #mandatory', 'modId="examplemod" #mandatory', 'version="${file.jarVersion}" #mandatory', ' displayName = "Example Mod" #mandatory',
    '#updateJSONURL="https://example.com/update.json" #optional', 'logoFile="examplemod.png" #optional', "authors='Eve, Frank' #optional",
    "description='''", '这是多行的简介。', '第二行，里面有 "引号" 和 # 井号。', "'''",
    '[[dependencies.examplemod]] #optional', '    modId="forge" #mandatory', '    mandatory=true #mandatory', '    versionRange="[47,)" #mandatory', '    ordering="NONE"', '    side="BOTH"',
    '[[dependencies.examplemod]]', '    modId="minecraft"', '    mandatory=true', '    versionRange="[1.20.1,1.21)"', '    ordering="NONE"', '    side="BOTH"',
    '[[dependencies.examplemod]]', '    modId="jei"', '    mandatory=false', '    versionRange="[15,)"', '    side="CLIENT"',
    '[[dependencies.examplemod]]', '    modId="serverthing"', '    mandatory=true', '    versionRange="[1,)"', '    side="SERVER"',
    '[[dependencies.examplemod]]', '    modId="geckolib"', '    mandatory=true', '    versionRange="[4.2,)"', '    ordering="AFTER"', '    side="BOTH"',
  ].join('\n');
  one('Forge：官方模板的写法（表头后面带 #注释、版本号占位符从 MANIFEST 里取、多行简介、单引号、可选的和只在服务端的不算前置）', {
    'META-INF/mods.toml': MDK, 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Title: examplemod\r\nImplementation-Version: 1.2.3\r\n', 'examplemod.png': png,
    'com/example/ExampleMod.class': classOf(17),
  }, (m) => ({ id: m.id, name: m.name, version: m.version, authors: m.authors, desc: m.description, loader: m.loader, ids: m.ids, deps: sec(m, 'forge').deps, mc: sec(m, 'forge').mc, icon: !!m.icon, classJava: m.classJava }),
  { id: 'examplemod', name: 'Example Mod', version: '1.2.3', authors: ['Eve, Frank'], desc: '这是多行的简介。\n第二行，里面有 "引号" 和 # 井号。', loader: 'forge', ids: ['examplemod'],
    deps: { forge: ['[47,)'], minecraft: ['[1.20.1,1.21)'], geckolib: ['[4.2,)'] }, mc: { kind: 'maven', ranges: ['[1.20.1,1.21)'] }, icon: true, classJava: 17 });

  one('NeoForge：neoforge.mods.toml 用 type 写前置（required / optional / incompatible / discouraged）', {
    'META-INF/neoforge.mods.toml': [
      'modLoader = "javafml"', 'loaderVersion = "[4,)"', 'license = "LGPL"', '', '[[mods]]', 'modId = "neomod"', 'version = "5.0.1"', 'displayName = "Neo Mod"', 'authors = "Grace"', 'description = "单行简介"', '',
      '[[dependencies.neomod]]', 'modId = "neoforge"', 'type = "required"', 'versionRange = "[21.1,)"', 'side = "BOTH"', '',
      '[[dependencies.neomod]]', 'modId = "minecraft"', 'type = "required"', 'versionRange = "[1.21.1]"', '',
      '[[dependencies.neomod]]', 'modId = "patchouli"', 'type = "optional"', 'versionRange = "[1.21-87,)"', '',
      '[[dependencies.neomod]]', 'modId = "badlib"', 'type = "incompatible"', 'versionRange = "(,2.0)"', 'reason = "崩溃"', '',
      '[[dependencies.neomod]]', 'modId = "meh"', 'type = "discouraged"', 'versionRange = "*"',
    ].join('\n'),
  }, (m) => ({ id: m.id, name: m.name, version: m.version, loader: m.loader, deps: sec(m, 'neoforge').deps, breaks: sec(m, 'neoforge').breaks, conflicts: sec(m, 'neoforge').conflicts, mc: sec(m, 'neoforge').mc }),
  { id: 'neomod', name: 'Neo Mod', version: '5.0.1', loader: 'neoforge', deps: { neoforge: ['[21.1,)'], minecraft: ['[1.21.1]'] }, breaks: { badlib: ['(,2.0)'] }, conflicts: { meh: ['*'] }, mc: { kind: 'maven', ranges: ['[1.21.1]'] } });

  one('Forge：一个 jar 里两个 Mod、jarjar 里套着的库', async () => ({
    'META-INF/mods.toml': ['modLoader="javafml"', 'loaderVersion="[47,)"', '[[mods]]', 'modId="first"', 'version="1.0"', 'displayName="First"', '[[mods]]', 'modId="second"', 'version="1.0"', 'displayName="Second"'].join('\n'),
    'META-INF/jarjar/lib-1.0.jar': await inner({ 'META-INF/mods.toml': ['modLoader="javafml"', '[[mods]]', 'modId="jjlib"', 'version="1.0"'].join('\n') }),
  }), (m) => ({ id: m.id, ids: m.ids, provides: m.provides }), { id: 'first', ids: ['first', 'second'], provides: ['jjlib'] });

  // ── 老 Forge ──
  one('老 Forge：mcmod.info 是数组；前置里的 Forge 自己不算', {
    'mcmod.info': JSON.stringify([{ modid: 'oldmod', name: 'Old Mod', version: '1.7.10-2.3', description: '老 Mod', authorList: ['Heidi'], mcversion: '1.7.10', requiredMods: ['Forge@[10.13.4.1558,)', 'CodeChickenCore@[1.0.7,)', 'NotEnoughItems'], logoFile: 'logo.png' }]),
    'logo.png': png,
  }, (m) => ({ id: m.id, name: m.name, version: m.version, authors: m.authors, loader: m.loader, ids: m.ids, deps: sec(m, 'forge').deps, icon: !!m.icon }),
  { id: 'oldmod', name: 'Old Mod', version: '1.7.10-2.3', authors: ['Heidi'], loader: 'forge', ids: ['oldmod'], deps: { CodeChickenCore: ['[1.0.7,)'], NotEnoughItems: ['*'] }, icon: true });

  one('老 Forge：mcmod.info 是 { modList: […] }，简介里直接换行', {
    'mcmod.info': '{\n "modListVersion": 2,\n "modList": [{\n  "modid": "listmod",\n  "name": "List Mod",\n  "version": "0.9",\n  "description": "第一行\n第二行",\n  "authors": ["Ivan"]\n }, { "modid": "listmod-core", "name": "Core" }]\n}',
  }, (m) => ({ id: m.id, version: m.version, authors: m.authors, ids: m.ids }), { id: 'listmod', version: '0.9', authors: ['Ivan'], ids: ['listmod', 'listmod-core'] });

  // ── 其他 ──
  one('同一个 jar 同时支持 Fabric 和 Forge：主信息按 Fabric，两边的前置分开记', {
    'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'multi', version: '1.0', name: 'Multi', depends: { 'fabric-api': '>=0.90' } }),
    'META-INF/mods.toml': ['modLoader="javafml"', '[[mods]]', 'modId="multi"', 'version="1.0"', '[[dependencies.multi]]', 'modId="architectury"', 'mandatory=true', 'versionRange="[9,)"'].join('\n'),
  }, (m) => ({ id: m.id, loader: m.loader, loaders: m.loaders, ids: m.ids, fabric: sec(m, 'fabric').deps, forge: sec(m, 'forge').deps }),
  { id: 'multi', loader: 'fabric', loaders: ['fabric', 'forge'], ids: ['multi'], fabric: { 'fabric-api': ['>=0.90'] }, forge: { architectury: ['[9,)'] } });

  one('OptiFine 的 jar（没有任何 Mod 信息，靠里面的类认）', { 'optifine/Differ.class': classOf(8), 'optifine/Installer.class': classOf(8) },
    (m) => ({ id: m.id, name: m.name, loader: m.loader, ids: m.ids }), { id: 'optifine', name: 'OptiFine', loader: 'optifine', ids: ['optifine'] });

  one('不是 Mod 的 jar：读出来是空的', { 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\n', 'com/example/Lib.class': classOf(8) }, (m) => m, null);

  one('只要基本信息（下载前远程读 jar 用）：不读图标、套着的 jar 和 class 版本', async () => ({
    'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'lightmod', version: '1.0', icon: 'icon.png', jars: [{ file: 'META-INF/jars/x.jar' }], depends: { minecraft: '1.20.1' }, entrypoints: { main: ['a.B'] } }),
    'icon.png': png, 'a/B.class': classOf(21), 'META-INF/jars/x.jar': await inner({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'x', version: '1' }) }),
  }), (m) => ({ id: m.id, icon: m.icon, provides: m.provides, classJava: m.classJava, deps: sec(m, 'fabric').deps }), { id: 'lightmod', icon: null, provides: [], classJava: 0, deps: { minecraft: ['1.20.1'] } }, { light: true });
  cases[cases.length - 1].light = true;

  for (const c of cases) {
    let got;
    try {
      const files = typeof c.files === 'function' ? await c.files() : c.files;
      const f = await jar(files);
      const m = c.light ? await core('zip').withZip(f, (z) => mods.metaFromZip(z, { light: true })) : await mods.readModMeta(f);
      got = m ? c.pick(m) : m;
    } catch (e) { got = `抛错：${e.message}`; }
    check('Mod 信息', c.name, same(got, c.want), same(got, c.want) ? '' : { want: c.want, got });
  }
  finish();
});
app.on('window-all-closed', () => {});
