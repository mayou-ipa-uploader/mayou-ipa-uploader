# GitHub 仓库设置与搜索曝光优化

## 可直接填写的仓库资料

| 字段 | 建议内容 |
| --- | --- |
| 仓库名称 | mayou-ipa-uploader |
| 产品展示名 | 码友证书管理 · Mayou IPA Uploader |
| 可见性 | 用于公开推广时选择 Public |
| Website | 暂不填写，待确认正式产品官网或下载页后设置 |

### About 简介

码友证书管理（Mayou IPA Uploader）：IPA 上传工具与 iOS 证书管理工具。支持 App Store Connect 上传、P12 与描述文件管理、Bundle ID、测试设备及 TestFlight 内测。MIT-licensed desktop client for IPA uploads and iOS certificates.

### Topics

ipa-uploader, ipa-upload, ios, app-store-connect, testflight, apple-developer, ios-certificates, certificate-manager, provisioning-profiles, p12, bundle-id, macos, desktop-app, open-source

均围绕实际用途选取；不要添加尚未提供的 Linux、自动签名或免费服务标签。客户端源码已整理，MIT 元数据见 LICENSE。

## 本地已完成

- 中英文产品名和清晰的首段定位，覆盖 IPA 上传、iOS 证书、App Store Connect 与 TestFlight。
- 中文主 README 和独立英文 README，相互提供语言切换入口。
- 将搜索需求写为真实使用场景，避免无意义重复关键词。
- 保留统一标题、加粗标签、分级列表和功能截图，不增加产品代码。
- 准备 v0.1.388 Release 文案及安装包 SHA-256。

## 仓库定位

公开真实客户端源码、产品介绍、截图、使用说明与安装包。第一方源码采用 MIT；不包含码友服务端与第三方运行时，不宣传全部服务免费。

## 发布时配置

1. 建立独立产品仓库；当前上级目录的 Gitee 仓库不是本产品的 GitHub 仓库。
2. 填写上述 Name、About、Topics；只有保存到 GitHub 才会成为线上仓库资料。
3. 提交 README.md、README.en.md、LICENSE、THIRD_PARTY_NOTICES.md、source 和 docs/images；source 下依赖与生成的二进制由 .gitignore 排除。维护资料可以保留在本地。
4. 创建 v0.1.388 Release，上传 DMG，填写版本说明与校验值。
5. 获得实际仓库地址后，补上中英文 README 的直接 Release 链接及社区文案中的仓库链接。
6. 使用仓库真实链接进行社区分享；发布后观察访问、下载和反馈，按实际问题更新文档。

## 发布后验证

- 用产品名和 IPA uploader、iOS 证书管理、TestFlight 等词查找仓库，并记录查询词、日期和结果。
- 在搜索中明确区分默认范围与包含 README 的范围；不同排序和查询条件可能产生不同结果。
- 结合仓库 Traffic、Release 下载和真实问题反馈判断改动是否有帮助；不将某一次搜索名次当作稳定排名。

## 优化边界与依据

这些修改改善信息完整度、关键词匹配与主题发现，不保证名次、收录时间或下载增长。不通过堆砌关键词、虚构能力或制造互动来宣传。

- GitHub Topics 官方说明：https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
- GitHub README 官方说明：https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
