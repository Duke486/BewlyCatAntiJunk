# 社区发布

## 本地生产构建

使用 Node.js 24 与 package.json 指定的 pnpm，执行：

```sh
pnpm install --frozen-lockfile
pnpm release:build
```

产物位于 `release-assets/v<版本>/`，包含 Chrome / Edge ZIP、Firefox 未签名 ZIP、校验文件和安装说明。构建会重新生成 `extension/` 和 `extension-firefox/`，不要与同目录开发进程同时运行。安装方式见 [安装说明](RELEASE-NOTES.md)。

## GitHub Release

1. 将发布流程与代码提交、推送到本仓库。
2. 在 GitHub Actions 中选择 **Release → Run workflow** 可以先验证构建；分支上的手动运行只上传 Actions 附件，不发布 Release。
3. 每次发布先修改 `package.json` 的 `version`，采用三段数字（首次沿用 1.8.1）。提交并推送后，创建并推送对应标签：

   ```sh
   git tag -a v1.8.1 -m "BewlyCatAntiJunk v1.8.1"
   git push origin v1.8.1
   ```

4. 标签触发 lint、类型检查、Knip、两个浏览器的生产构建及打包，全部成功才公开创建 Release。分享仓库的 [最新版本](https://github.com/Duke486/BewlyCatAntiJunk/releases/latest) 页面即可。

标签必须与 package.json 版本一致；已发布版本不可重复使用。标签构建失败时，可在修复后使用新版本标签；仅网络等临时故障可重跑失败任务。也可以在已有标签上手动运行 Release 工作流。已存在同名 Release 时不会覆盖其附件。

工作流使用 GitHub 自动提供的 GITHUB_TOKEN，仅发布任务授予 contents: write，无需个人令牌或扩展商店密钥。仓库须启用 Actions，并允许该工作流使用写权限。可选的 `pnpm exec release-it` 只管理版本、提交与标签，由标签工作流负责构建发布；不会调用上游商店提交，也不调用不存在的 test 脚本。

Firefox 使用本项目独立的扩展 ID，未签名 ZIP 不能直接作为普通 Firefox 的永久安装包。商店上架及 Mozilla 签名需另行配置。
