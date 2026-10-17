## 下载与安装

- **Chrome / Edge**：下载名称以 `chrome-edge.zip` 结尾的安装包，完整解压到固定目录。在 `chrome://extensions/` 或 `edge://extensions/` 开启开发者模式，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。安装后请保留该文件夹。
- **Firefox**：`firefox-unsigned.zip` 是未签名构建，用于开发测试。解压后在 `about:debugging#/runtime/this-firefox` 临时加载 `manifest.json`，重启浏览器后失效。正式长期安装需要 Mozilla 签名，GitHub Release 不会自动完成签名。
- `SHA256SUMS.txt` 提供两个安装包的 SHA-256 校验值。GitHub 自动生成的 Source code 是源码，不是安装包。

更新时将新版解压内容替换到原安装目录，在扩展管理页点击重新加载，再刷新 Bilibili。请先通过扩展设置备份配置；不要卸载旧扩展，以免丢失本地数据。

本项目是 BewlyCat 的独立衍生版。建议停用其他 Bewly 系扩展，避免重复注入。首次使用 AI 评论过滤，请在设置中填写自己的 DeepSeek API Key 并开启功能；请求产生的 API 用量由自己的账号承担。

安装包随附完整 LICENSE，保留上游版权及许可声明。
