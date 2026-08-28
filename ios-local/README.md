# Tally（本地优先版，iOS）

原生 iOS 个人记账 App：**无账号、离线优先、隐私至上**。

- 技术栈：SwiftUI + SwiftData + Swift Charts + LocalAuthentication + Swift Testing + XCUITest
- 最低系统：iOS 17（在 Xcode 26.6 / iOS 26 SDK 下构建）
- 目标设备：iPhone
- 无任何第三方依赖，无远程后端

> 与仓库根目录 `ios/`（服务端客户端）和 `backend/`（旧后端）相互独立，互不影响。

## 功能（已实现）
- 首次引导（无注册）→ 自动创建默认账本/账户/分类
- 记一笔：支出 / 收入 / 转账 / 退款（退款可关联原交易）
- 交易增删改查、复制、软删除 + 「最近删除」恢复
- 账户管理（现金/银行卡/信用卡/电子钱包/储蓄/其他 + 初始余额 + 归档；有流水时禁止删除）
- 分类管理（内置 + 自定义 + 图标颜色 + 启停）
- 首页：本月收入/支出/结余 + 最近交易
- 明细：搜索 + 类型/分类/账户/日期/金额筛选 + 按日分组汇总
- 统计：分类占比（环形图）+ 每日收支趋势（Swift Charts）+ 无障碍文字
- 预算：总预算 + 分类预算 + 进度 + 接近/超支提示
- 数据：CSV 导入导出、完整 JSON 备份/恢复、清除全部数据（二次确认）
- 设置：默认币种、每月起始日、外观（浅/深/跟随）、生物识别锁、隐私说明、版本

## 目录结构
```
ios-local/
├── TallyLocal.xcodeproj        # Xcode 工程（App、单元/集成测试、UI 测试）
├── Tally/                      # 应用源码
│   ├── App/                    # 入口、Root、AppState
│   ├── Models/                 # SwiftData 实体
│   ├── Core/                   # Money / Currency / DateRange / LockService
│   ├── Services/               # Balance / Stats / Budget / CSV / Backup / Snapshot / Seed
│   ├── Views/                  # 各页面
│   └── Support/Assets.xcassets
├── TallyTests/                 # Swift Testing 单元与 SwiftData 集成测试
├── TallyUITests/               # XCUITest 关键端到端流程
└── docs/                       # 调研、PRD、架构文档
```

## 构建与运行
```bash
# 需要 macOS + Xcode 26.x
cd ios-local
open TallyLocal.xcodeproj        # 在 Xcode 中选模拟器运行
# 或命令行：
xcodebuild -project TallyLocal.xcodeproj -scheme Tally \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

## 测试
```bash
xcodebuild -project TallyLocal.xcodeproj -scheme Tally \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
# 当前基线：99 条 Swift Testing（11 套件）+ 2 条 XCUITest
```

## 未完成（诚实标注）
- iCloud/CloudKit 同步、周期交易、模板、小组件、Siri：未进入 MVP
- 繁体/英文本地化：仅简体中文
- iPad 独立布局：未做
- 真机、Archive/App Store 上传、万级交易性能与完整 VoiceOver 人工走查：尚未完成

## 隐私
- 数据全部保存在本机 SwiftData store，不上传任何服务器。
- 无广告 SDK、无第三方分析、不读取通讯录/短信。
- 生物识别失败回退设备密码。
- 在同一前台会话关闭生物识别锁后重新开启会**立即重新锁定**并要求再次认证，不会在关锁/开锁后继续停留在主界面。
- 详见 `Tally/Views/Settings/SettingsView.swift` 中的「隐私说明」。
