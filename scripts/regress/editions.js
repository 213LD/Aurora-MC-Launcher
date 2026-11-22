'use strict';
/**
 * 测试在哪个版本里跑、这个版本该是什么样：内部版和公开版的差别只在这里写一次。
 *
 * 这份代码是哪个版本，和启动器自己一样看 package.json 的 auroraEdition（导出公开版时写进去，src/main/engine/edition.js 也读它）。
 * 测试里不要再写死数据目录名、窗口标题、显示的版本号、免责声明的版本，也不要自己去查「scripts/edition.js 在不在」
 * 「MC 百科是不是替身」来猜版本：从这里取（踩坑检查守着）。界面上的每一处差别由 edition-ui.js 按 TABLE 逐项查，两个版本都跑。
 *
 * TABLE 里的数据目录名、appId 是写死的：玩家的数据就放在这个名字的文件夹里，名字一改老数据就找不到了。
 * 程序里的值（src/shared/brand.js）和这里对不上，edition-ui.js 会报出来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BRAND = require(path.join(REPO, 'src', 'shared', 'brand'));
const { toPublic } = require(path.join(REPO, 'src', 'shared', 'edition'));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const exists = (...p) => fs.existsSync(path.join(REPO, ...p));

const TABLE = {
  internal: {
    dataDirName: 'Aurora Launcher',
    appId: 'dev.aurora.launcher',
    title: `${BRAND.name}（内部版）`,
    aboutTag: '（内部版）',
    shownVersion: (v) => v,
    mcmod: 'real', // MC 百科：真的实现（只在中文界面出现）
    debugPassword: true, // 调试菜单要密码，输对了才有「安全限制」一节
    setupSteps: { zh: 7, en: 6 }, // 中文界面的向导最后一页是 MC 百科
    workDir: 'aurora-regress',
  },
  public: {
    dataDirName: 'Aurora MC Launcher',
    appId: 'dev.aurora.mclauncher',
    title: BRAND.name,
    aboutTag: '（公开版）',
    shownVersion: toPublic, // 内部 2.x.y = 公开 1.x.y，界面上显示公开版的号
    mcmod: 'concept', // 只有概念演示的替身（src/edition/public），也只在中文界面出现
    debugPassword: false,
    setupSteps: { zh: 6, en: 6 },
    workDir: 'aurora-regress-public',
  },
};

const PUBLIC = pkg.auroraEdition === 'public';
const name = PUBLIC ? 'public' : 'internal';
const cur = TABLE[name];

/** 用 git 查（公开版的副本可能不是 git 仓库，查不到就是 null / []） */
const git = (...args) => { try { return execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim(); } catch { return null; } };

/**
 * 拿老版本的代码做测试（upgrade.js、legacy-location.js）时要哪些 tag。
 * 两个仓库各有各的版本号：内部版的 v1.0.0 和公开仓库的 v1.0.0 是两份不同的代码，
 * 所以内部版用各个测试自己挑的那几版（internalList），公开版用公开仓库里最近的几个 tag；这份代码里没有的跳过。
 */
function oldTags(internalList, { latestPublic = 3 } = {}) {
  const have = new Set((git('tag') || '').split(/\r?\n/).filter(Boolean));
  if (!PUBLIC) return { tags: internalList.filter((t) => have.has(t)), missing: internalList.filter((t) => !have.has(t)) };
  const recent = (git('tag', '--sort=-creatordate') || '').split(/\r?\n/).filter(Boolean).slice(0, latestPublic).reverse();
  return { tags: recent, missing: [] };
}

/** 老版本代码的缓存目录：按提交号放，不按 tag 名（两个仓库同名的 tag 不会拿错代码） */
function oldSrcDir(base, tag) {
  const sha = git('rev-parse', `${tag}^{commit}`);
  return sha ? path.join(base, 'old-src', sha.slice(0, 12)) : null;
}

module.exports = {
  REPO,
  PUBLIC,
  name,
  TABLE,
  ...cur,
  /** 测试的工作目录：两个版本默认分开，可以同时跑；AURORA_REGRESS_DIR 照旧能指定 */
  BASE: process.env.AURORA_REGRESS_DIR || path.join(os.tmpdir(), cur.workDir),
  /** 只在私人仓库的工具（导出公开版、打公开版的脚本、MC 百科的单元测试）在不在 */
  privateRepo: exists('scripts', 'edition.js'),
  /** 封存的繁体语言包在不在（只在私人仓库） */
  hant: exists('src', 'shared', 'i18n', 'tr-zh-TW.js'),
  /** 免责声明现在的版本：测试的配置里写它，表示已经同意过（改了条款不用再改一堆测试） */
  DISCLAIMER: require(path.join(REPO, 'src', 'main', 'disclaimer')).VERSION,
  oldTags,
  oldSrcDir,
  git,
};
