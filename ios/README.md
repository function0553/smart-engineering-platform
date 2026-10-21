# 智慧工程 iOS 测试工程

版本 `0.1.0 / build1`，最低 **iOS 17**，包名 `cn.smartengineering.dailyreport`。这是新建的原生 UIKit / WKWebView 客户端工程，接入252现有专用手机页面和权限体系。不是此前已有苹果APP的覆盖更新，也不是已签名IPA。

## 使用和签名

用 Xcode 打开 `SmartEngineering.xcodeproj`，选择共享方案 `SmartEngineering`。模拟器可直接构建；连接 iPhone 测试时，在 **Signing & Capabilities → Team** 选择自己的 Apple 开发团队，并确认包名可注册。开发者证书和描述文件由自己的账号管理，不放入工程。选择设备运行前，按手机系统要求启用开发者模式。TestFlight 还需 Apple Developer Program 团队和 App Store Connect 中的应用及测试配置。

首次交付时没有签名身份，交付的是源工程及未签名设备归档。2026-10-19后续已在用户授权下配置Personal Team并创建Apple Development证书，当前仍缺已注册的实体iPhone和开发描述文件；尚未生成可安装签名包。详见 `docs/iOS个人团队签名准备-20261019.md`。不能把 `.app` 或未签名归档改名为IPA后让用户安装。

电脑端和安卓使用原账号。iOS安装后同样使用原平台账号；不会预置账号密码。测试后台固定为 `https://211.139.12.141:21901`，请保留登录页的默认后台地址。

## 已接入的能力

- 原生窗口、安全区、返回手势与返回按钮；重新加载前提示先保存填写内容。
- 同一服务器上的施工日报、施工影像、工程管理、七类施工资料、照片/视频十道工序、单页照片Word、在线监理日报Word、施工日报原件直接归入。
- WKWebView 的系统文件选择、照片/视频输入入口；相机与麦克风按系统授权，实际硬件拍摄尚待真机测试。
- 原件及Word使用原生下载和系统分享面板，可选择“存储到文件”或交给文档应用。施工原件按服务端 `X-Content-SHA256` 验证摘要，所有下载检查字节数及256MiB上限；不把未完成文件交给系统分享。
- 下载临时文件使用完整文件保护；分享结束或取消后删除临时副本，启动时清理残留。用户主动保存到系统文件或其他APP的副本由用户管理。取消分享不会删除252已提交业务。

页面随252更新；客户端原生代码的后续版本仍需签名分发。没有离线提交队列、离线初次加载、原生推送、电子签章或App Store上线。

## 自动更新

客户端启动和返回前台时自动查询Apple的版本目录，检查间隔6小时；“更多 → 检查APP更新”支持手动检查。仅发送公开包名，使用系统默认HTTPS信任，不携带平台账号、令牌或施工资料。只接受相同包名、合法版本号和对应应用ID的 `apps.apple.com` 更新地址，不提示降级；操作系统不支持新版本时提示先升级iOS。网络失败不删除草稿或阻止当前填写。

公开商店有新版本时提示保存填写内容，再由用户前往App Store，系统按其自动更新设置安装。当前未上架时如实提示尚无App Store更新；不能显示虚假的“已发布新版”。TestFlight构建的自动更新由TestFlight管理，待团队签名与分发配置完成后测试。客户端不从252下载任意IPA并静默覆盖安装；App Store更新和线上业务页面更新分别验收。

项目长期交付要求：所有APP均须纳入自动检查/更新渠道、原签名或合法分发、版本与数据兼容、失败提示及账号/草稿保留检查。

## 网络与数据边界

252使用项目内部CA，并非系统默认信任的公共证书。工程仅包含与安卓相同的**公有CA证书**，不含CA私钥、服务器私钥、用户密码、会话或业务数据。

iOS的ATS对该内部CA有附加限制。Info.plist只对 `211.139.12.141` 设置单地址例外；最低TLS1.2并要求前向保密。没有全局 `NSAllowsArbitraryLoads` 或 `NSAllowsArbitraryLoadsInWebContent`。应用自己的导航策略和内容规则仅放行固定的HTTPS主机/21901端口，拦截HTTP和其他主机；认证挑战仍使用SSL主机名策略、指定CA、证书链和有效期校验，失败即拒绝。iOS17以下没有纳入本候选支持范围。

业务请求保留既有移动令牌和服务器权限。没有可供网页执行任意原生命令的JavaScript桥。隐私清单列出用户标识、姓名、照片视频和其他业务内容用于功能；提交App Store前仍须结合实际部署补齐隐私政策、App Store隐私说明和组织信息，不能把本清单当作已完成审核。

## 可复现检查

在项目根目录执行（Xcode路径按本机配置）：

```sh
xcodebuild -project ios/SmartEngineering.xcodeproj -scheme SmartEngineering \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath outputs/ios-20261019/SmartEngineering-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive
```

原生策略及完整性检查使用 `ios/Tests/main.swift`、`PlatformPolicy.swift`、`DownloadIntegrity.swift` 和 `ServerTrust.swift`；信任测试需先将本次已核对的公有服务器叶证书以DER格式放到 `outputs/ios-20261019/server-leaf.cer`。UI测试方案在 `EngineeringUITests`，只用合成Word，不提交生产业务。测试注入代码只在 `DEBUG && simulator` 编译，Release和设备归档不包含该入口。

最终构建、模拟器和下载字节证据见 `outputs/ios-20261019/delivery-receipt.json`。模拟器不代表实体iPhone上的签名安装、相机、系统文件保存或WPS打开验收。

技术依据：[Apple WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate)、[ATS地址例外](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)、[Apple测试分发说明](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)。
