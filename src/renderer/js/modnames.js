'use strict';
/**
 * Mod 中文名 / 缩写对照表（双轨制的轨道一：本地对照库；轨道二是 MC 百科，见 mcmodui.js）。
 * 思路受 PCL2（Mod 中文名）和 HMCL（内置对照表）启发；这张表是本项目自己整理的，没有复制它们的数据。
 * 每行：Modrinth slug | 英文名（拿去搜索）| 中文名 | 其他叫法（逗号分隔，可空）
 * 中文名的规矩（1.7.0，照 MC 百科逐条核对过）：MC 百科上有中文名的用它的叫法；没有官方 / 民间中文名的不自己起名，
 * 写「英文名 + 是做什么的」（例如「Iris 光影」）。以前自己起的名字留在「其他叫法」里，只用来搜索、不显示
 * A.modNames.expand(query)：查询里有中文或命中缩写时，换成英文名搜索；A.modNames.zhOf(project)：结果卡片上显示的中文名
 */
(function () {
  const RAW = `
sodium|Sodium|钠|
lithium|Lithium|锂|
starlight|Starlight|星光|光照优化
iris|Iris Shaders|Iris 光影|iris,光影
oculus|Oculus|Oculus 光影|
embeddium|Embeddium|Embeddium 渲染优化|
rubidium|Rubidium|铷|
indium|Indium|铟|
ferrite-core|FerriteCore|铁氧体磁芯|内存优化
modernfix|ModernFix|现代化修复|
immediatelyfast|ImmediatelyFast|ImmediatelyFast 渲染优化|
entityculling|Entity Culling|实体渲染机制优化|
c2me-fabric|Concurrent Chunk Management Engine|C^2M 引擎|c2me,多线程区块
krypton|Krypton|氪|网络优化
dynamic-fps|Dynamic FPS|动态 FPS|动态帧率
distanthorizons|Distant Horizons|Distant Horizons 远景渲染|dh,远景,遥远的地平线
bobby|Bobby|服务器区块缓存|
continuity|Continuity|Continuity 连接纹理|ctm,连接纹理
fabric-api|Fabric API|Fabric API|
modmenu|Mod Menu|模组菜单|mod 菜单
cloth-config|Cloth Config API|Cloth Config 配置库|
architectury-api|Architectury API|Architectury 跨平台库|
geckolib|GeckoLib|GeckoLib 动画库|
curios|Curios API|Curios 饰品栏|饰品,饰品栏
trinkets|Trinkets|Trinkets 饰品栏|
patchouli|Patchouli|帕秋莉手册|
kubejs|KubeJS|KubeJS 脚本|
jei|Just Enough Items|JEI物品管理器|jei,物品管理器,合成表
rei|Roughly Enough Items|REI物品管理器|rei
emi|EMI|EMI 物品管理器|
jade|Jade|玉|方块信息,高亮显示
wthit|WTHIT|WTHIT 方块信息|
appleskin|AppleSkin|苹果皮|饱食度
journeymap|JourneyMap|旅行地图|
xaeros-minimap|Xaero's Minimap|Xaero的小地图|小地图
xaeros-world-map|Xaero's World Map|Xaero的世界地图|世界地图,大地图
inventory-profiles-next|Inventory Profiles Next|一键背包整理Next|ipn,整理背包
mouse-tweaks|Mouse Tweaks|鼠标手势|
controlling|Controlling|键位冲突显示|按键搜索
shulkerboxtooltip|Shulker Box Tooltip|潜影盒提示框|潜影盒预览
3dskinlayers|3D Skin Layers|3D 皮肤层|
customskinloader|CustomSkinLoader|万用皮肤补丁|csl
simple-voice-chat|Simple Voice Chat|简单的语音聊天|语音
no-chat-reports|No Chat Reports|禁用聊天举报|ncr
chunky|Chunky|预生成区块|区块预生成
spark|spark|火花|性能分析
litematica|Litematica|投影|投影mod
minihud|MiniHUD|迷你HUD|
tweakeroo|Tweakeroo|Tweakeroo 操作增强|
worldedit|WorldEdit|创世神|we
replaymod|Replay Mod|录像回放|回放,录像
flashback|Flashback|Flashback 回放|
lambdynamiclights|LambDynamicLights|Lambd的动态光源|动态光源
sound-physics-remastered|Sound Physics Remastered|物理声效重制版|声音物理
ambientsounds|AmbientSounds|自然音效|环境音效
physics-mod|Physics Mod|真实物理|
first-person-model|First-person Model|更真实的第一人称模型|第一人称模型
not-enough-animations|Not Enough Animations|更多动画|
yes-steve-model|Yes Steve Model|是，史蒂夫模型|ysm
figura|Figura|Figura 自定义模型|
create|Create|机械动力|机动
ae2|Applied Energistics 2|应用能源2|ae2,ae,应用能源
mekanism|Mekanism|通用机械|mek
thermal-expansion|Thermal Expansion|热力膨胀|热力
immersiveengineering|Immersive Engineering|沉浸工程|ie
enderio|Ender IO|末影接口|eio
industrial-foregoing|Industrial Foregoing|工业先锋|
refined-storage|Refined Storage|精致存储|rs
toms-storage|Tom's Simple Storage|Tom's 简易存储|
powah|Powah|Powah 能源|
gregtechceu-modern|GregTech CEu Modern|格雷科技 CEu|gt,格雷
ad-astra|Ad Astra|Ad Astra 太空探索|
botania|Botania|植物魔法|
ars-nouveau|Ars Nouveau|新生魔艺|
irons-spells-n-spellbooks|Iron's Spells 'n Spellbooks|Iron的法术与魔法书|铁魔法
blood-magic|Blood Magic|血魔法|
twilightforest|The Twilight Forest|暮色森林|暮色
aether|The Aether|天境|以太
blue-skies|Blue Skies|蔚蓝浩空|
biomes-o-plenty|Biomes O' Plenty|超多生物群系|bop
terralith|Terralith|Terralith 地形生成|
tectonic|Tectonic|Tectonic 地形生成|
alexs-mobs|Alex's Mobs|Alex 的生物|
mowzies-mobs|Mowzie's Mobs|Mowzie的生物|
ice-and-fire-dragons|Ice and Fire|冰火传说|冰与火
cataclysm|L_Ender's Cataclysm|灾变|
yungs-better-dungeons|YUNG's Better Dungeons|YUNG 的地牢优化|
when-dungeons-arise|When Dungeons Arise|地牢浮现之时|地牢崛起
towns-and-towers|Towns and Towers|Towns and Towers 村庄结构|
guard-villagers|Guard Villagers|警卫村民|村庄守卫
easy-villagers|Easy Villagers|简单村民|村民物品化
minecraft-comes-alive-reborn|Minecraft Comes Alive Reborn|虚拟人生|mca,凡家物语
cobblemon|Cobblemon|方块宝可梦|宝可梦
vampirism|Vampirism|吸血鬼|血族传说
tinkers-construct|Tinkers' Construct|匠魂|
silent-gear|Silent Gear|寂静装备|
better-combat|Better Combat|Better Combat 战斗动作|
epic-fight|Epic Fight|史诗战斗|
timeless-and-classics-zero|Timeless and Classics Zero|永恒枪械工坊：零|tacz,枪械,永恒枪械
farmers-delight|Farmer's Delight|农夫乐事|
croptopia|Croptopia|作物盛景|
serene-seasons|Serene Seasons|静谧四季|季节
tough-as-nails|Tough As Nails|意志坚定|
botany-pots|Botany Pots|植物盆栽|
quark|Quark|夸克|
supplementaries|Supplementaries|锦致装饰|
chipped|Chipped|Chipped 方块变种|
macaws-furniture|Macaw's Furniture|Macaw 的家具|家具
handcrafted|Handcrafted|精巧手艺|
decorative-blocks|Decorative Blocks|装饰方块|
iron-chests|Iron Chests|更多箱子|铁箱子
storage-drawers|Storage Drawers|储物抽屉|抽屉
sophisticated-backpacks|Sophisticated Backpacks|精妙背包|背包
travelersbackpack|Traveler's Backpack|旅行者背包|
waystones|Waystones|传送石碑|传送石,指路石
corpse|Corpse|遗体|
gravestone-mod|Gravestone Mod|墓碑|
carry-on|Carry On|搬运|
`;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const LIST = RAW.trim().split('\n').map((line) => {
    const [slug, en, zh, alias] = line.split('|');
    return { slug, en, zh, aliases: (alias || '').split(',').map((x) => x.trim()).filter(Boolean) };
  });
  const bySlug = new Map(LIST.map((x) => [x.slug, x]));
  const byTitle = new Map(LIST.map((x) => [norm(x.en), x]));
  const CJK = /[一-鿿]/;

  /**
   * 查询里有中文，或整个查询正好是某个缩写（比如 ae2、eio）时，返回 { query: 英文名, matches, original }；
   * 否则 { query: 原文, matches: [] }。有中文但没查到时 missed = true（提示玩家改用英文名）
   */
  // 中文名只在简中界面用：英文、繁中界面既不显示中文名，也不拿中文名匹配搜索
  const zhUi = () => !window.I18N || window.I18N.getLang() === 'zh-CN';

  function expand(q) {
    const raw = String(q || '').trim();
    const n = norm(raw);
    if (!n || !zhUi()) return { query: raw, matches: [] };
    const hasCjk = CJK.test(raw);
    let matches = [];
    if (hasCjk) {
      const exact = LIST.filter((x) => norm(x.zh) === n || x.aliases.some((a) => norm(a) === n));
      const part = LIST.filter((x) => !exact.includes(x) && (norm(x.zh).includes(n) || x.aliases.some((a) => CJK.test(a) && norm(a).includes(n))));
      matches = [...exact, ...part].slice(0, 8);
    } else {
      matches = LIST.filter((x) => x.aliases.some((a) => norm(a) === n) && norm(x.en) !== n).slice(0, 4);
    }
    if (!matches.length) return { query: raw, matches: [], missed: hasCjk };
    return { query: matches[0].en, matches, original: raw };
  }

  /** 结果卡片上的中文名（没收录返回 ''） */
  function zhOf(p) {
    if (!p || !zhUi()) return '';
    const e = bySlug.get(p.slug) || byTitle.get(norm(p.title));
    return e && e.zh !== e.en ? e.zh : '';
  }

  A.modNames = { expand, zhOf, list: LIST };
})();
