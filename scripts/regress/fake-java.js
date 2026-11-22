'use strict';
/**
 * 假的 Java（rc11）：在游戏目录的 runtime 里放一个「Java N」，只有 release 文件和一个空的 java.exe。
 * 启动器检测 Java 时先读 release 文件，读得到版本号和架构就不会去运行它，所以认得出这是 Java N。
 *
 * 为什么要有它：假配置（没有游戏文件）默认要 Java 8，这台电脑和测试目录里都没有，
 * 启动器会先从网上下载约 190 个文件，下完才走到「缺少游戏文件」。三项测试（界面的 launch-twice、game-pause，
 * 主进程的 launch-guard）因此要联网，网慢时超时。放一个假的进去，这几项就不碰网络了。
 * 只能用在走不到「真的运行 Java」那一步的测试里：假配置没有客户端 jar，检查游戏文件时就停下了。
 */
const fs = require('fs');
const path = require('path');

/** 在 gameDir/runtime/fake-java-<major> 放一个假的 Java，返回它的目录。放完要让启动器重新检测（java:detect 传 true，或者在第一次检测之前放） */
function fakeJava(gameDir, major = 8) {
  const home = path.join(gameDir, 'runtime', `fake-java-${major}`);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const version = major <= 8 ? `1.${major}.0_402` : `${major}.0.9`;
  fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${version}"\nOS_ARCH="x86_64"\nIMPLEMENTOR="Regress Fake"\n`, 'utf8');
  for (const exe of process.platform === 'win32' ? ['java.exe', 'javaw.exe'] : ['java']) fs.writeFileSync(path.join(home, 'bin', exe), '');
  return home;
}

module.exports = { fakeJava };
