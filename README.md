# 🚀 Cloudflare Workers 节点聚合订阅与管理系统

这是一个基于 Cloudflare Workers 构建的节点聚合、订阅与管理系统。项目自带 **Nginx 首页及 404 伪装**，支持**管理后台身份验证（Cookie 鉴权）**以及**客户端免密长链接同步（URL 参数鉴权）**。核心静态配置已全部移入环境变量与机密（Variables and Secrets），实现代码与敏感数据分离。

本项目不含订阅转化，只做多订阅多节点的聚合输出，适用于有自己的分流规则。

---

## 🛠️ 首次部署 / 重新部署指南

部署该项目时，请按照以下步骤操作：

### 步骤 1：创建并绑定 KV 命名空间
该系统使用 KV 存储节点配置与缓存。
1. 登录 Cloudflare 控制台，进入 **存储与数据库 (Storage & Databases)** -> **KV**。
2. 点击 **创建命名空间 (Create Namespace)**，命名为 `SUBS_KV`（或其他你喜欢的名字）。
3. 进入 **Workers & Pages**， 点击 **Create Application** -> **Start with Hello World!** -> **Deploy**
4. 找到 **Bindings** 区域，点击 **Add binding**，选择 **KV namespace**：
   * **Variable name (变量名)**：必须填写 `SUBS`（代码中严格匹配）。
   * **KV namespace (KV 命名空间)**：选择你刚刚创建的 `SUBS_KV`。

### 步骤 2：配置环境变量与机密 (Variables and secrets)
在**Settings**页面中，你需要添加以下两个核心变量：

1. **配置管理密码 (Secret)**：*如不设置，则有默认密码：Admin@SUBM*
   * 在 **Variables and secrets** 区域，点击 **+Add**。
   * **Key**：`password`
   * **Value**：`填写你自定义的管理员登录密码`（Cloudflare 会对其进行加密存储）。
2. **配置专属路径 (Environment Variable)**：
   * 仍在 **Variables and secrets** 区域，点击 **+Add**。
   * **Key**：`TOKEN`
   * **Value**：`填写一串复杂的随机字符串或单词`（例如：`mysecrettoken2026`）。

### 步骤 3：部署 Worker 代码
1. 复制最新版本的 `worker.js` 完整代码。
2. 在 Workers 编辑器中粘贴并覆盖所有内容。
3. 点击 **Save and Deploy (保存并部署)**。

### 步骤 4：配置Domains访问
1. 找到 **Domains** 区域，点击 **Add Domain**，
2. 选择自己的域名进行绑定。

---

## 🔍 访问与路由规则说明

系统部署完成后，其路由逻辑自带全方位伪装，请牢记以下访问入口：

| 访问路径 | 鉴权方式 | 页面表现 | 实际功能 |
| :--- | :--- | :--- | :--- |
| `https://你的域名/` | 无需鉴权 | 标准 Nginx 欢迎页 | 网站根目录伪装，防止探测 |
| `https://你的域名/robots.txt` | 无需鉴权 | 文本内容 | 告诉爬虫不要索引此网站 |
| `https://你的域名/任意错误路径` | 无需鉴权 | Nginx 404 Not Found | 完美的 404 伪装，拒敌于国门之外 |
| `https://你的域名/${TOKEN}/admin` | **浏览器登录 (Cookie)** | 极简安全验证面板 | 成功输入密码后进入**管理后台** |
| `https://你的域名/${TOKEN}?pw=${password}` | **URL 参数鉴权** | 纯文本 Base64 订阅 | **客户端拉取专用**，直接导入代理软件 |

---

## 💡 日常维护与操作流

为了保持代码的干净和系统的稳定，日常维护遵循以下“三权分立”原则：

### 1. 我想要修改登录密码 / TOKEN
* **操作方法**：直接去 Worker 的 **Settings -> Variables and secrets** 页面，修改 `password`（Secrets）或 `TOKEN`（环境变量）的值，然后点击保存发布。
* **注意**：**千万不要**去修改 Worker 的代码。修改完密码后，网页端和客户端都需要使用新密码重新登录/同步。

### 2. 我想要添加、修改或删除节点/机场订阅
* **操作方法**：直接在浏览器访问管理页 `https://你的域名/你的TOKEN/admin`，输入密码登录。
* **功能支持**：
  * 支持直接添加单行节点链接（`vless://`、`ss://`、`hy2://` 等）。
  * 支持添加其它机场的传统下发订阅链接。
  * 所有的增删改查完全在网页端图形化操作，数据自动保存在绑定的 KV 中。

### 3. 客户端如何安全拉取？
* 登录进入 `/admin` 管理后台后，顶部会自动生成一条包含 `?pw=你的密码` 后缀的专属长链接。
* 点击 **📋 复制订阅地址**，直接贴入 Shadowrocket、Clash、v2rayN 等客户端中即可。每次客户端更新时会自动带上密码完成无感鉴权。

---

## 🗂️ 核心架构速查 (面向开发者)

* **身份保持**：网页端验证成功后，Worker 会颁发一个名为 `auth_session` 的 Cookie，有效期为 **24小时**（`Max-Age=86400`），采用 `HttpOnly` 和 `Strict` 安全策略。
* **性能优化**：
  * 密码与 TOKEN 存放在内存变量中，Worker 匹配时无需进行 KV 的网络 I/O 请求，响应速度达到毫秒级。
  * 节点订阅缓存（`cache`）存在 KV 中，并设置了 10 分钟（600秒）的过期时间，防止频繁触发外部机场请求导致被封。
