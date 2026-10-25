# 上传 GitHub 指南

## 推荐上传目录

使用本目录中的“待上传仓库”。它只包含可公开的源码、脱敏截图、说明、许可证及 GitHub 配置，已经建立独立本地 Git 仓库，无远程地址。不要从上级“码尚友SEO”目录执行推送。

独立目录导出后不会自动同步后续修改。修改源码或 README 后，在原“码友证书管理Git”目录运行 node tools/prepare-upload.mjs 更新待上传副本；脚本保留 .git，但如果导出目录有未列入上次清单的新文件或文件被手工修改，会停止，避免覆盖你的修改。

## 发布源码

1. 在 GitHub 新建公开仓库，建议名称 mayou-ipa-uploader。不要在 GitHub 初始化额外 README 或许可证，以免首次推送时出现历史冲突。
2. 在终端进入“待上传仓库”，确认 git status 只包含本产品文件。
3. git add .
4. git commit -m "Publish Mayou client source and documentation"
5. 使用实际新仓库地址执行 git remote add origin；不要填上级项目的 Gitee 地址。
6. git push -u origin main

本次没有代建远程仓库、添加远程地址、创建提交或推送。首次 commit 需要你已配置 Git 用户名和邮箱；需要 GitHub 登录或凭据时使用自己的 GitHub 客户端流程，不要把令牌写进文档。

## 填写仓库资料

About 和 Topics 可复制根目录 GitHub仓库设置.md 中的内容。实际推送 source 和 LICENSE 后，才可在仓库 About 中准确描述第一方客户端源码按 MIT 开放；第三方运行时和服务不因此免费或开源。

## 发布安装包

在 GitHub 创建 v0.1.388 Release，上传原目录中的 DMG 作为附件。Release 说明和 SHA-256 见 docs/Release-v0.1.388.md。DMG 不在普通 Git 提交中，也不在待上传仓库中。

发布后再用真实仓库及 Release 地址更新中英文 README 下载链接；目前不填写虚构链接。

## 仍需了解

- 源码有 408 项本机测试通过，GitHub CI 尚未在线运行。
- 服务端、Apple 上传运行资源和线上账户权限需要自行准备。
- MIT 范围见 LICENSE 和 THIRD_PARTY_NOTICES.md；品牌素材及第三方组件遵守各自条款。
