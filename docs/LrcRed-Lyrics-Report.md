# LrcRed Lyrics — 双引擎插件说明与复检记录

**当前版本**：0.2.2（`versionCode: 5`）
**插件 ID**：`io.github.sxsxhhi.lrcredlyrics`
**协议**：Lyrico Plugin API 5，Host API ≥ 4
**项目规范**：见上级目录 `AGENTS.md`（目录职责、发布流程、硬性约束）

## 版本历史

| 版本 | 要点 |
|---|---|
| 0.1.1 | 仅 lrc.red 单引擎；版本判据为"任一标签不对称即冲突"，会误杀 Remaster；候选必须四字段齐全 |
| 0.2.0 | 合并 Apple Music 主引擎；版本三态 + 黑名单；`al`/`date` 放开；预算 18s；经 6 轮复检修掉 21 项缺陷 |
| 0.2.1 | iTunes 429 冷却改为 30/60/120/300s 分级；目录归并为单工作目录；构建脚本改为版本驱动 + `--publish` |
| **0.2.2** | 邮箱门禁按引擎解耦；新增 iTunes 检索本地映射缓存；艺人合作符号增强；元数据兜底对齐；测试增至 81 项全绿 |

---

## 1. 目录结构

```
Lyrico/
├── AGENTS.md                                   项目规范
├── LrcRed-Lyrics-0.2.2-Lyrico-Plugin.zip       发布产物
└── LrcRed-Lyrics/                              工作目录
    ├── src/            manifest.json / source.js / icon.png
    ├── tests/          harness.js / fixtures.js / cases.js（73 项）
    │   └── baseline-0.1.1/   0.1.1 只读快照，供 A9/A10 缺陷复现
    ├── docs/           本报告 + archive/0.1.1-report.md
    ├── dist/           构建中间产物
    └── build.py
```

插件包根目录恰好三个文件；构建固定时间戳，重复打包字节一致。

## 2. 双引擎架构

```
getLyrics
├─ 邮箱门禁（全局硬门禁）→ title+artist 必需 → Host HTTP/XML 能力检查
├─ 引擎 A：Apple Music TTML                  窗口 11s
│    ├─ 区顺序：华语 hk→tw→us→jp / 外语 us→jp→hk→tw
│    ├─ 每区搜索前检查剩余 ≥1.8s（预算门控）
│    ├─ iTunes 检索 → 标题核心词 / 版本三态 / 艺人交集 / 时长 ±5s
│    ├─ 3 个不同 origin 的 AMLL 镜像，剩余 ≥1.5s 才发
│    └─ 逐字覆盖 + 时长轴门禁 → 命中产出候选
└─ 引擎 B：lrc.red                           剩余预算（5s 硬预留）
     ├─ ISRC 直取 → /match.json → /search.json
     └─ A 命中时只补 1 条；两引擎同源时按 rawTtml 去重
```

引擎 A 排最前（含有 ISRC 的歌），保证 Apple 官方逐字优先。

## 3. 关键设计

### 3.1 版本三态

| 状态 | 判定 | 处理 |
|---|---|---|
| `conflict` | 对称差 ∩ HARD 非空 | 拒绝 |
| `unknown` | 本地有专辑、候选无专辑 | **保留** |
| `consistent` | 其余 | 通过 |

HARD：live / remix / demo / instrumental / cover / acoustic / karaoke / nightcore / sped_up / slowed。
SOFT（不拒）：remaster / extended / radio_edit / taylor_version / deluxe / mono。

### 3.2 预算

| 常量 | 值 |
|---|---|
| 总预算 | 18000 ms |
| 引擎 A 窗口 | min(11000, 总−5000) |
| 引擎 B 预留 | 5000 ms |
| 请求上限 | 14 |
| 最小发包预算 | 150 ms |

### 3.3 冷却（0.2.1 变更）

| 来源 | 策略 |
|---|---|
| iTunes | 连续 429：30s → 60s → 120s → 300s（封顶），10 分钟无复发回落 30s |
| lrc.red | 固定 90s |
| AMLL 镜像 | 固定 90s，按镜像名各自独立 |
| 503 | 固定 30s，不参与递增 |
| `Retry-After` | 大于分级值且 ≤300s 时优先采用 |

实现要点：冷却记录存 `"<step>:<until>:<last>"`，`until` 决定何时恢复，记录本身保留 `衰减窗口 + 冷却时长`，否则记录会随冷却同时过期，递增历史丢失（见 §6 第 7 轮）。

### 3.4 缓存

键前缀 `lrcred.v02.`；`track.<isrc>` 与 `apple.<appleId>` 均 12h，记录内带 `cachedAt` 与 `probe`，命中后仍按当前歌曲重新仲裁身份与时长。

---

## 4. 与 music-tag-lyrics v1.8.5 的差异

| | 母本 T1 | 本插件 |
|---|---|---|
| ID 发现 | 本地 4 MiB 索引 + iTunes 四区 | 仅 iTunes，四区预算门控 |
| 时长证据 | `lookup_durations` 单独请求 | 不 lookup，search 自带 `trackTimeMillis` |
| 镜像 | 6 个 + origin 攒票 | 3 个不同 origin，不攒票 |
| 速率合规 | 1 req/s 强制限速 | 无 timer，靠请求数少 + 429 分级冷却 |
| 结果形态 | 单个最优 | 最多 2 条 |
| 多源仲裁 | 等级单调 + 降级阻断 | 无（交互式手动选源） |

两个项目独立维护，代码不同步。

---

## 5. 离线测试

`node tests/cases.js` — **82 PASS / 0 FAIL**。

| 组 | 覆盖 | 项数 |
|---|---|---|
| A 版本判据 | 软标签放行、硬标签拒收、`unknown` 保留、0.1.1 缺陷复现 2 项 | 10 |
| B 引擎 A | 区序、逐区降级、四道过滤、镜像换源、回落、脏 ID 等 | 13 |
| C 时长门禁 | 覆盖率、预览、冲轴、地板、浅 text | 8 |
| D 预算与隔离 | 窗口耗尽、请求封顶、429、异常、无邮箱、开关 | 7 |
| E 引擎 B 回归 | ISRC、match、缺字段兜底、缓存跨歌重校验 | 5 |
| F 静态契约 | `node --check`、manifest 断言 | 2 |
| G 正则降级 | CJK 清洗 | 1 |
| H 一轮修复 | 秒制时长、strict 容差、命名空间、非 TTML source | 6 |
| I 二~四轮修复 | 冷却自过期、12h 过期、低预算、畸形 probe 等 | 10 |
| J 五轮修复 | 同源去重、艺人斜杠切分 | 2 |
| K 六轮验证 | 全译文行、命名空间幂等、缺开关默认值 | 3 |
| **T 分级冷却** | 30/60/120/300s、衰减回落、`Retry-After`、lrc.red 不回归 | **6** |
| **L 架构与健壮性** | 邮箱解耦、iTunes 映射缓存（0 请求秒出）、艺人多分隔符、元数据兜底、lrc.red 无时长兜底 | **9** |

基线对照：A9/A10 用 `tests/baseline-0.1.1/source.js` 断言 0.1.1 的两个缺陷成立。

---

## 6. 复检与修复循环

### 第 1 轮：数据契约与健壮性（8 项）

时长单位只按毫秒（改为 <3600 视为秒）· `!Platform` 抛 ReferenceError（改 typeof 守卫）· `body` 查询异常连累整体（独立 try/catch）· `lrTitleCore` 漏剥 deluxe/mono/ver/explicit/clean · `duration` 的 pick 让 0 盖掉非零 · `meta.source` 与 `rawTtml` 重复存储（剥离，probe 随缓存）· `source` 非 TTML 时不回退 `.ttml` · 跳过引擎 B 无日志。

### 第 2 轮：缓存语义与预算边界（7 项）

冷却依赖宿主 TTL 单位（值内写绝对过期）· track/apple 缓存同样依赖（加 `cachedAt`）· `Math.max(200,…)` 撑破死线（<150ms 不发）· `source` 可解析但无逐字时挡住回退（`lrAcceptTtml`）· 畸形 probe 被信任（`lrValidProbe`）· 缓存命中重解析 200KB XML（probe 复用）· 二阶段缺 400ms 余量。

### 第 3 轮：配置类型（3 项）

switch 传布尔 `false` 时引擎 A 关不掉（`lrBool`）· `match_mode` 大小写敏感 · probe 未校验行数 ≥1。

### 第 4 轮：门禁漏洞（1 项）

本地无时长标签时三道路径全跳过，30s 预览可能被接受（改用 `hit.duration` 兜底）。

### 第 5 轮：可移植性与交互（2 项）

正则字符类 `/` 未转义 · 两引擎同源时出现两条相同候选（去重）。

### 第 6 轮：验证（0 项缺陷）

补 3 项用例锁定行为，一次通过。

### 第 7 轮：分级冷却实现（1 项）

**新缺陷**：冷却记录与冷却时长共用同一个 TTL，冷却一到期记录就被清除，下一次 429 读不到 `step`，递增永远停在 30s。T2/T3 用例直接暴露（60s、300s 断言失败）。
**修复**：记录保留期改为 `衰减窗口 + 冷却时长`，由 `until` 字段决定何时恢复请求，二者解耦。修复后 T1–T6 全通过。

### 第 8 轮：架构解耦与防限流深度优化（v0.2.2，4 项）

- **邮箱门禁解耦**：彻底移除 `getLyrics` 入口全局硬门禁，Apple Music 官方源完全独立免邮箱运行；仅在进入 lrc.red 时校验邮箱，未填时平稳跳过。
- **iTunes 检索映射缓存**：新增 `itunes.q` 12 小时本地映射缓存，曲目二次检索实现 0 网络请求秒出，彻底化解 429 阶梯封禁隐患。
- **艺人切分与合作曲目匹配**：扩展 `lrArtistSet` 支持 ` x `, ` × `, ` with `, ` vs `，彻底解决合作曲目因无法切分导致集合无交集误拒。
- **元数据兜底对齐与缓存边界统一**：Apple Music 候选在远端缺专辑/年份时回退本地标签；`lrGetTrack` 统一按完整序列化 JSON 载荷大小限制校验。

### 第 9 轮：边界漏洞与鲁棒性深度强化（3 项）

- **lrc.red 候选无时长兜底**：本地音频缺少时长标签时，`lrCandidate` 回退使用 `meta.duration` 参与 `lrTtmlCheck`，补全了 lrc.red 路径对试听预览截断的防线（新增 L9 用例）。
- **iTunes 匹配艺人逻辑归一化**：`lrItunesMatch` 废弃 open-coded 集合求交，统一调用 `lrArtistCompatible`，消除两处艺人判据潜在漂移。
- **JSON 解析 UTF-8 BOM 容错**：`lrGetJson` 增加前置 `replace(/^\ufeff/, "")`，防御非标服务端的 UTF-8 BOM 导致解析崩溃；`lrItunesCacheKey` 增加对纯标点曲名的冲突防护。

### 结论

第 9 轮修复后 82 项用例全通过，未再发现可识别缺陷。此结论仅覆盖离线可验证范围。

---

## 7. 验证边界

**未在 Android 真机安装 Lyrico，也未向 iTunes / AMLL 镜像 / lrc.red 发起真实请求。** 测试基于官方文档描述的宿主接口形状、全合成夹具、自实现 XML mock。

未证实项：域名可达性 · `findElements` 对 `body@dur` 的支持 · 宿主墙钟是否短于 18s · 空 `date` 是否被接受 · Apple 回链是否可直达 · 真实命中率与耗时。

---

## 8. 真机试用顺序

1. 填邮箱，搜一首热门英文歌，确认出现 `source: Apple Music`。
2. 看日志 `[apple] hit id=… region=… mirror=… elapsed=…`，判断命中区与耗时。
3. 搜一首只有 lrc.red 有的冷门歌，确认回退链路。
4. 搜一首带 `(Remastered)` 的本地文件，确认不被版本门误杀。
5. 关掉 `apple_tier` 再搜，确认回到单引擎行为。
6. 掐表看总时长是否超过 18s，判断墙钟是否截断。

失败时记录：Lyrico 版本、Android 版本、脱敏后的标题与艺人、`match_mode`、`apple_tier`、插件日志。日志里不得出现真实联系邮箱。

---

## 9. 产物哈希（0.2.2）

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `LrcRed-Lyrics-0.2.2-Lyrico-Plugin.zip` | 25,627 B | `2f40561e7b9e1b35f37a04e8686576717b89b7e41d26e743428dfcee9a29defd` |
| `manifest.json` | 2,819 B | `c8b876d25666f82086e9d5a50cb05ee4632f374ea40390463240ef80f7335fad` |
| `source.js` | 39,149 B | `00004d690454abb582b2848c722d2fc233d9b228364934c9a406bd731c88b8b0` |
| `icon.png` | 13,185 B | `3e96a13676f86c1df819fe77344ebc21c8119e4fc00920b8988c53a6855f23b4`（与 0.1.1 逐字节相同） |

构建：`python build.py`；发布：`python build.py --publish`。
