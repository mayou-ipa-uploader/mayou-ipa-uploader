# 许可证范围与第三方说明

本仓库提供的码友证书管理第一方客户端源码按根目录 LICENSE（MIT）许可。软件名称、商标与相关品牌权益不因此授予；第三方代码、素材、运行时和服务分别适用其自身条款。

## 不包含的运行资源

- Apple Transporter 及其运行资源：未随源码复制，不适用本项目 MIT 许可。需从 Apple 官方渠道取得，并遵守其适用条款。
- Java/JDK、Electron 浏览器运行时、Windows Python：不提交预编译运行资源，按各自官方分发和许可证使用。
- ASM 9.7.1：构建脚本包含固定来源与 SHA-256；其 BSD 风格许可证保留于 source/vendor/ipa-upload-guard/LICENSE.txt。脚本构建时下载依赖，本仓库不提交 JAR。

## 依赖与素材

Node.js 第三方依赖由 package-lock.json 固定，安装后请保留各依赖自身 LICENSE 和 notices。Electron、node-forge、plist、bplist-parser、i18n-iso-countries、pngjs、qrcode、yauzl、TypeScript 等依赖的许可不由本项目 MIT 替代。

界面中若包含平台图标、支付标识或其他第三方素材，使用前需核对相应权利；MIT 声明仅适用于本项目有权授权的内容。

## 服务与现成安装包

公开客户端源码不包含码友服务端、账号授权服务及 Apple 服务，也不赋予对这些服务的额外访问权限。已有官方安装包内第三方组件及商业服务的使用仍适用相应条款；本许可证不承诺在线服务免费或永久可用。
