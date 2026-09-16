# 许可证与第三方依赖复核

> 复核日期：**2026-09-17**（后端 `backend/`：Node 24 + pnpm 11.19.0，**生产依赖 202 个包**）。
> 复核命令见文末第 4 节；依赖变更后请重跑并把结论更新回本文。

## 1. 本项目许可

**MIT License**，见仓库根目录 [LICENSE](../LICENSE)（`Copyright (c) 2026 cccbleach`）。

iOS 客户端（`ios/`、`ios-local/`、`ios/TallyWidget/`）**不含任何第三方依赖**：无 Swift Package、
无 CocoaPods、无 Carthage、无 `Package.resolved`；所有 `import`（AppIntents、Charts、CryptoKit、
Foundation、LocalAuthentication、Observation、PhotosUI、Security、SwiftData、SwiftUI、UIKit、
UniformTypeIdentifiers、Vision、WidgetKit）**全部是 Apple 平台框架**。
因此 App 分发时不存在需要随包附带的第三方许可声明。

## 2. 生产依赖许可分布

| 许可证（SPDX / 声明原文） | 包数 | 性质 |
|---|---|---|
| MIT | 147 | 宽松 |
| ISC | 28 | 宽松 |
| Apache-2.0 | 12 | 宽松（保留 NOTICE） |
| BSD-3-Clause | 5 | 宽松 |
| `MIT/X11` | 2 | MIT 变体 |
| `Apache License 2.0`（SPDX 写法变体） | 1 | 宽松 |
| `BlueOak-1.0.0` | 1 | 宽松（OSI 认可） |
| `Unlicense` | 1 | 公有领域 |
| `(MIT OR WTFPL)` | 1 | 取 MIT |
| `(MIT OR GPL-3.0-or-later)` | 1 | **取 MIT 分支** |
| `(MIT AND Zlib)` | 1 | 两者皆宽松 |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` | 1 | 取 MIT |
| **未声明** | 1 | ⚠️ 见 2.1 |
| **合计** | **202** | |

**结论：运行时依赖中没有任何 GPL / AGPL / SSPL / CDDL / EPL / MPL 等传染性（copyleft）许可。**
唯一的 GPL 关联是 `jszip` 的**双许可**（`MIT OR GPL-3.0-or-later`），我们按 **MIT** 分支使用，
不产生 GPL 义务。

### 2.1 需要人工过目的项

| 包 | 声明 | 复核结论 |
|---|---|---|
| `jszip@3.10.1` | `MIT OR GPL-3.0-or-later` | 取 **MIT** 分支 ⇒ 无 GPL 义务（经 `exceljs` 传入） |
| `pako@1.0.11` | `MIT AND Zlib` | 两者皆宽松，随包保留许可声明即可 |
| `rc@1.2.8` | `BSD-2-Clause OR MIT OR Apache-2.0` | 取 MIT |
| `expand-template@2.0.3` | `MIT OR WTFPL` | 取 MIT |
| `@darabonba/typescript@1.0.5` | `Apache License 2.0` | Apache-2.0（阿里云 SDK 依赖），保留 NOTICE |
| `chainsaw@0.1.0`、`traverse@0.3.9` | `MIT/X11` | MIT 变体 |
| `buffers@0.1.1` | **未声明** | ⚠️ 见下 |

### 2.2 `buffers@0.1.1`（唯一未声明许可证的包）

- **来源**（`pnpm why buffers`）：`exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1`
- **用途**：仅出现在 xlsx 账单导入的解析链路（`src/lib/xlsxWorker.cjs` 内 `require("exceljs")`）。
- **现状**：npm registry 元数据与包内 `package.json` 均**没有 `license` 字段**，tarball 内也没有
  LICENSE 文件；上游仓库 `github.com/substack/node-buffers`（作者 James Halliday / substack，
  该生态惯例为 MIT）在本次复核所在网络不可达，**无法核验**到许可证文本。
- **影响评估：低**。该包只做 Buffer 拼接，且本项目是**服务端自用部署**（不对外分发 npm 包、
  不随 App 分发），不触发再分发条款。
- **如需彻底消除不确定性**，三选一（按推荐顺序）：
  1. 用 `pnpm.overrides` 把它钉到有明确声明的等价实现；
  2. 替换 xlsx 解析链路中依赖 `unzipper` 的部分（`exceljs` 的 zip 层是可替换点）；
  3. 保留现状并在此登记为「已知未声明项」——**当前选择**（服务端自用、非分发）。

## 3. 其余许可相关事项

- **不复制上游代码**：仓库内没有 vendored（拷入源码）的第三方实现；`backend/src/lib/xlsxWorker.*`
  与 `pdfExtract.*` 是本项目自己的解析封装，仅**调用**依赖库。
- **Alibaba Cloud SDK**（`@alicloud/*`）为 Apache-2.0，用于短信与凭据；不以任何形式随客户端分发。
- **字体 / 图标 / 图片**：App 图标与界面图形为本项目自制，无第三方素材授权问题。
- **CI 附加检查**：`pnpm audit --audit-level=critical --prod`（安全公告），以及
  `scripts/check-no-secrets.sh`（凭证特征）。**许可证复核目前是人工定期执行**，不在 CI 里（依赖变更时重跑本文第 4 节）。

## 4. 复核方法

```bash
cd backend

# 全量生产依赖清单（人读）
pnpm licenses list --prod

# 分布统计 + 挑出需要人工过目的项（机读）
pnpm licenses list --prod --json | node -e '
let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{
  const j=JSON.parse(raw);const by={};
  for(const [lic,arr] of Object.entries(j)) by[lic]=(by[lic]||0)+arr.length;
  for(const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(v,k);
  const bad=[];for(const [lic,arr] of Object.entries(j))
    if(!/^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|Unlicense|BlueOak-1\.0\.0)$/.test(lic))
      for(const p of arr) bad.push(p.name+"@"+p.versions.join(",")+" ["+lic+"]");
  console.log("\n需人工过目:",bad.length); bad.forEach(x=>console.log(" ",x));
});'

# 追某个包的来源链
pnpm why <包名>

# 顺带安全公告
pnpm audit --audit-level=critical --prod
```

> 判定标准：出现 `GPL-*` / `AGPL-*` / `SSPL` / `CDDL` / `EPL` / `MPL` 且**不是**"OR 宽松许可"的
> 运行时依赖 ⇒ 视为阻断项，必须先替换或移除再发布。
