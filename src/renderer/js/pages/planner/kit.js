'use strict';
/* Mod 配置器（2.0.0-pre9 按步骤拆开）：共用的状态和常量。① 选择版本与玩法 → ② 生成清单与兼容性分析 → ③ 下载安装 → ④ 测试启动与排查。文件之间互相调用都走 K */
(function () {
  const { api } = A;
  const STEPS = [
    { n: 1, title: '版本与玩法', sub: '选择版本、加载器与想玩的类型' },
    { n: 2, title: 'Mod 清单', sub: '查看推荐、解决冲突与前置' },
    { n: 3, title: '下载安装', sub: '创建配置并下载全部 Mod' },
    { n: 4, title: A.t('term.testAndDebug'), sub: `${A.t('term.test')}，定位问题 Mod` },
  ];
  const LOADER_INFO = {
    fabric: { kind: 'fabric', desc: '轻量、更新快，性能优化 Mod 最多' },
    forge: { kind: 'forge', desc: '老牌加载器，大型科技 / 魔法 Mod 多' },
    neoforge: { kind: 'neoforge', desc: 'Forge 的继任者，1.20.2 起的主流' },
    quilt: { kind: 'quilt', desc: '兼容大部分 Fabric Mod' },
  };
  const SOURCE_BADGE = { pick: ['精选', 'accent'], popular: ['热门', ''], import: ['导入', 'info'], custom: ['手动添加', 'info'], dependency: ['前置', ''], local: ['本地文件', 'warn'] };

  const P = {
    meta: null, plan: null, step: 1, plans: null,
    loaderAvail: {}, resolved: null, resolving: false, resolveSeq: 0,
    installTaskId: null, check: null, test: null, testing: false,
    bisect: null, bisecting: false, rounds: [], liveTask: null,
  };

  const newPlan = () => ({ id: null, name: '', mc: '1.20.1', loader: 'fabric', styles: ['performance', 'qol'], items: [], profileId: null, step: 1 });
  const save = A.debounce(async () => {
    if (!P.plan || P.plan.troubleshootOnly || P.plan.mode === 'edit') return;
    if (!P.plan.id && !P.plan.items.length && P.step === 1) return; // 什么都还没选的新方案不存
    try {
      const saved = await api('planner:save', { ...P.plan, step: P.step });
      P.plan.id = saved.id;
    } catch { /* 忽略 */ }
  }, 600);


  A.plannerKit = { LOADER_INFO, P, SOURCE_BADGE, STEPS, newPlan, save, body: null };
})();
