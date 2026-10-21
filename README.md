# 智慧工程

施工资料、项目管理及工程业务平台源码。此次源码对应平台 **0.6.0-rc.39**、安卓 **0.3.35 / code41** 的冻结发布基线。

七类施工资料按项目、施工部位和资料日期整理，支持按筛选或单日打包ZIP；管理员可统一查看，其他账号按既有项目、类别、部位和下载权限访问。工序照片按服务器已保存的当前工序代表图自动生成Word入包，无需单独点击生成；未上传的本机照片不入表。原件、视频、已有历史Word、目录清单一起保留，不改变审核或归档状态。零图保留十个工序空格，部分工序缺图会列出缺项。

## 本地运行

需要Node.js 24.14或更新的24.x版本及npm。先按 [TEMPLATE_ASSETS.md](TEMPLATE_ASSETS.md) 私下恢复受控运行模板；不复制生产数据库进行一般开发。

```sh
npm ci
npm run check
npm run build
npm run build:mobile
npm test
npm run dev
```

开发页面默认使用Vite配置中的本机地址；服务端配置见 `server/index.mjs`。首次进入空数据库由使用者自行设置管理员，不在仓库中预置账号密码。需要真实视觉模型的用例另有安装条件，构建成功不代表视觉模型或现场验收。

## 安卓构建

仅使用现有正式签名身份，禁止生成替代签名。通过项目负责人受控恢复 `private/android/signing.json`、`private/android/daily-report.p12` 及用于签名一致性核验的 `delivery/smart-engineering-daily-report-0.3.13.apk`。这些文件均不进Git。

设置 `REPORT_JAVA_HOME`（JDK21）、`REPORT_ANDROID_TOOLS`（Android build-tools35目录）、`REPORT_ANDROID_PLATFORM`（android-35/android.jar）、`REPORT_ANDROID_OUTPUT`（本机输出目录），完成网页与移动资源构建后运行：

```sh
npm run build:android
```

默认入口仅调用本次原签名构建器 `scripts/build-auto-word-android.py`，不会自动新建密钥。原生专项校验入口为 `scripts/check-site-library-native.py`，在执行前通过相同 `REPORT_JAVA_HOME`、`REPORT_ANDROID_TOOLS`、`REPORT_ANDROID_PLATFORM` 变量设置自己的工具链。APK和签名凭据不包含在源码仓库内。发布还需要统一版本清单、备份和正式环境校验，不能以源码推送代替部署。

## 源码与资产边界

- 业务代码来自本次冻结快照，文件摘要见 `SOURCE_EXPORT.json`。
- 测试使用隔离生成的合成数据；不含生产数据库、真实图片视频、账号密码、用户历史或手机草稿。
- 四份原始运行DOCX作为受控资产排除，恢复要求见上文。
- `miniprogram/` 及 `ios/` 为额外保留的源文件，不属于本次安卓发行验收；iOS不包含个人开发团队绑定、签名或用户工程状态，苹果仍需后续真机验证。
- `ops/deploy252/` 为本次发布过程参考，需要外部受限凭据及本机审核回执；不具备凭据时不会自动部署。冻结脚本记录的是本次工作目录约定，外部工程师需按自己的受控发布目录配置。
- 没有授予新的开源许可证；第三方组件权利和声明见 `THIRD_PARTY_NOTICES.txt`。
