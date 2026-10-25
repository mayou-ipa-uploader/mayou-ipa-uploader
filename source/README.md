# 码友证书管理客户端源码

这里是从真实桌面项目整理的 0.1.388 客户端源码，不是功能示例或空壳。第一方代码使用根目录 MIT 许可证；第三方范围见 [第三方说明](../THIRD_PARTY_NOTICES.md)。原开发项目未改动。

## 目录

| 目录或文件 | 内容 |
| --- | --- |
| src/main.js | Electron 主进程、Apple 会话、证书、设备与应用管理 |
| src/certificate-manager.js / .html | 证书管理主界面与交互 |
| src/ipa-upload-worker.js | 独立 IPA 上传执行流程 |
| src/ipa-upload-state.js | IPA 信息读取、回执与苹果处理状态查询 |
| src/testflight-service.js / testflight-ui.js | TestFlight 服务与界面 |
| src/apple-auth-client.js | Apple 登录会话客户端 |
| daemon/main.go | Go 本地服务源码 |
| uploader.py | Python 上传实现源码；桌面当前主流程使用内置执行环境 |
| scripts/ | 原打包脚本与 Java 上传兼容组件源码 |
| tests/ | 单元与界面逻辑回归测试 |

## 开发环境与启动

准备 Node.js 22+、npm、Go 1.22+ 和 JDK 11+。JDK 建议使用 21；设置 JAVA_HOME 为 JDK 根目录，或 JAVA_TOOLS 为其 bin 目录。Electron 版本由锁文件固定。

在 source 目录依次执行：

1. npm ci：安装依赖及官方 Electron 运行时。
2. npm run setup：保留已有配置，缺失时复制示例配置；编译 Go daemon 和 Java 上传兼容组件。
3. npm run doctor：检查开发运行环境，不登录或探测线上账户。
4. npm run dev：使用跨平台启动脚本打开客户端。

setup 会从 Maven 下载 ASM 9.7.1，并先检查固定 SHA-256 再编译。不会下载或运行 Apple 上传器，不会登录 Apple，不会执行生产安装包脚本。

普通独立启动默认连接 production 配置地址；developmentMode 字段本身不切换主进程服务地址。你可修改本地配置，或设置 IPAUPLOADER_AUTH_BASE_URL。示例配置包含现有公开服务域名，但不包含账户凭据或绕过授权；本仓库没有码友服务端实现和完整服务端接口规范。

## 检查

- npm run typecheck：类型检查。
- npm test：运行回归测试。
- npm run build:guard：只重新编译上传兼容组件。
- go -C daemon test ./...：检查 Go 源码。

先运行 setup，再运行测试。JVM 测试使用 JAVA_TOOLS 或 JAVA_HOME 指向的 JDK；未安装 Electron 或 JDK 时，相应集成测试明确跳过。发布材料附有本次 408 项全部通过的本机验证记录。

CI 在 Linux 上执行无 GUI 检查，不安装 Electron GUI，相关平台测试会跳过；CI 工作流已准备但尚未在 GitHub 运行，不能视为已取得线上绿色状态。

## IPA 上传与打包所需额外资源

源码不包含以下运行资源：

- vendor/itms/：Apple Transporter、其适用 Java/JDK 与依赖；
- uploader-bin/：平台上传执行程序；
- daemon/ipauploader-daemon：应由已公开 Go 源码编译；
- 码友服务端、付费授权与审核协作服务。

准备来自官方渠道且适配平台的 Transporter 后，再使用相应上传功能。兼容组件可通过 npm run build:guard 从公开源码构建；构建不依赖苹果闭源 JAR。不建议直接运行原打包脚本：它们还需要完整运行资源、签名环境和原项目的统一发布流程。

公开的是客户端源码，不代表现成的官方安装包可以仅凭 npm ci 完整复现。真实 IPA 上传、线上授权及测试服务仍需要正确资源与账户权限。

## 整理差异

- 未复制 node_modules、安装包、已编译 daemon、Java/Transporter 二进制、工作目录或历史运行数据。
- 本地配置改为 example 文件；生产接口地址是客户端已有的公开访问地址，不含账户凭据。
- 移除两个测试中对其他桌面项目的交叉读取，保留本客户端断言；JVM 测试缺依赖时跳过。兼容组件构建脚本允许使用 JAVA_TOOLS 指定本机 JDK。
- package.json 与锁文件补充 MIT 和 Node 版本元数据；产品介绍不嵌入代码示例，开发说明单独放在本目录。
- 新增跨平台 setup、doctor 和启动脚本，使用可配置的 JDK 构建 guard。
- 修正过时的授权合并测试，验证新版到期时间和原授权字段能正确合并；未改变产品授权逻辑。
