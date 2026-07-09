export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        const path = url.pathname
        
        const TOKEN = env.TOKEN
        // 优先读取你设置的 Secret 密码，如果没有设置，则默认使用 "Admin@SUBM"
        const savedPassword = env.password || "Admin@SUBM" 

        const config = await getConfig(env)

        // =====================
        // Nginx 首页伪装 (无需鉴权)
        // =====================
        if (path === "/") {
            return nginxPage()
        }

        // =====================
        // robots.txt (无需鉴权)
        // =====================
        if (path === "/robots.txt") {
            return new Response(
                "User-agent: *\nDisallow: /",
                {
                    headers: {
                        "content-type": "text/plain; charset=utf-8",
                        "server": "nginx",
                        "connection": "keep-alive"
                    }
                }
            )
        }

        // =====================
        // 处理登录认证 API 提交
        // =====================
        if (path === `/${TOKEN}/auth/login` && request.method === "POST") {
            try {
                const body = await request.json()
                if (body.password === savedPassword) {
                    // 验证通过，发放 Cookie，有效期 1 天
                    return new Response(JSON.stringify({ success: true }), {
                        headers: {
                            "Content-Type": "application/json",
                            "Server": "nginx",
                            "Set-Cookie": `auth_session=${encodeURIComponent(savedPassword)}; Path=/${TOKEN}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
                        }
                    })
                }
                return json({ success: false, msg: "密码错误" })
            } catch (e) {
                return json({ success: false, msg: "非法请求" })
            }
        }

        // =====================
        // 身份验证
        // =====================
        if (path.startsWith(`/${TOKEN}`)) {
            
            const cookies = request.headers.get("Cookie") || ""
            let isAuthed = cookies.includes(`auth_session=${encodeURIComponent(savedPassword)}`)

            // 2. 检查 URL 传参 (适合客户端直接拉取订阅，如 /TOKEN?pw=密码)
            const paramPw = url.searchParams.get("pw")
            if (paramPw === savedPassword) {
                isAuthed = true
            }

            if (!isAuthed) {
                if (path === `/${TOKEN}/admin`) {
                    return html(loginPage(TOKEN))
                }
                return nginxNotFound()
            }
        } else {
            return nginxNotFound()
        }

        // ========================================================
        // 验证通过
        // ========================================================

        // =====================
        // 输出订阅
        // =====================
        if (path === `/${TOKEN}`) {
            const cache = await env.SUBS.get("cache")
            if (cache) {
                return text(cache)
            }
            return buildSubscription(config, env)
        }

        // =====================
        // 管理页面
        // =====================
        if (path === `/${TOKEN}/admin`) {
            const status = JSON.parse(await env.SUBS.get("status") || "[]")
            const update = await env.SUBS.get("last_update") || "Never"

            const host = request.headers.get("host") || url.host
            const protocol = request.headers.get("x-forwarded-proto") || "https"
            const mySubUrl = `${protocol}://${host}/${TOKEN}?pw=${encodeURIComponent(savedPassword)}`

            return html(adminPage(config, status, update, mySubUrl))
        }

        // =====================
        // 添加 API
        // =====================
        if (path === `/${TOKEN}/api/add` && request.method === "POST") {
            const body = await request.json()
            if (!body.name || !body.url) {
                return json({ success: false })
            }

            config.sites.push({
                name: body.name.trim(),
                url: body.url.trim()
            })

            await saveConfig(env, config)
            await env.SUBS.delete("cache")

            return json({ success: true })
        }

        // =====================
        // 删除 API
        // =====================
        if (path === `/${TOKEN}/api/delete` && request.method === "POST") {
            const body = await request.json()
            config.sites = config.sites.filter(v => v.url !== body.url)

            await saveConfig(env, config)
            await env.SUBS.delete("cache")

            return json({ success: true })
        }

        // =====================
        // 强制刷新 API
        // =====================
        if (path === `/${TOKEN}/api/refresh` && request.method === "POST") {
            return buildSubscription(config, env)
        }

        return nginxNotFound()
    },

    async scheduled(event, env) {
        const config = await getConfig(env)
        await buildSubscription(config, env)
    }
}

// =====================
// KV配置
// =====================
async function getConfig(env) {
    const data = await env.SUBS.get("config")
    if (!data) {
        const init = { sites: [] }
        const bjDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
        const bjTimeString = bjDate.toISOString().replace('T', ' ').substring(0, 19)
        await env.SUBS.put("last_update", bjTimeString)
        return init
    }
    return JSON.parse(data)
}

async function saveConfig(env, config) {
    await env.SUBS.put("config", JSON.stringify(config))
}

function isNode(url) {
    return /^(vmess|vless|trojan|ss|ssr|hy2|hysteria2|tuic|anytls):\/\//i.test(url)
}

function renameNode(node, name) {
    const nodeName = encodeURIComponent(name)
    const index = node.lastIndexOf("#")
    if (index >= 0) {
        return node.substring(0, index + 1) + nodeName
    }
    return node + "#" + nodeName
}

function decodeBase64(str) {
    try {
        str = str.replace(/-/g, "+").replace(/_/g, "/");
        while (str.length % 4) { str += "="; }
        const binaryString = atob(str);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
        return str;
    }
}

// =====================
// 聚合订阅
// =====================
async function buildSubscription(config, env) {
    const nodes = []
    const status = []

    await Promise.all(
        config.sites.map(async item => {
            if (isNode(item.url)) {
                nodes.push(renameNode(item.url, item.name))
                status.push({ name: item.name, type: "node", ok: null, count: 1 })
                return
            }

            try {
                const res = await fetch(item.url, {
                    headers: { "User-Agent": "Shadowrocket" }
                })

                if (!res.ok) {
                    status.push({ name: item.name, type: "sub", ok: false, count: 0 })
                    return
                }

                const raw = await res.text()
                const content = decodeBase64(raw.trim())
                const list = content
                    .split(/\r?\n/)
                    .map(v => v.trim())
                    .filter(Boolean)
                    .filter(isNode)

                nodes.push(...list)
                status.push({ name: item.name, type: "sub", ok: list.length > 0, count: list.length })
            } catch (e) {
                status.push({ name: item.name, type: "sub", ok: false, count: 0 })
            }
        })
    )

    const map = new Map()
    for (const n of nodes) {
        const index = n.lastIndexOf("#")
        const key = index > 0 ? n.substring(0, index) : n
        map.set(key, n)
    }

    const result = [...map.values()].join("\n")
    const encoded = btoa(unescape(encodeURIComponent(result)))

    const bjDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const bjTimeString = bjDate.toISOString().replace('T', ' ').substring(0, 19)

    await env.SUBS.put("cache", encoded, { expirationTtl: 600 })
    await env.SUBS.put("status", JSON.stringify(status))
    await env.SUBS.put("last_update", bjTimeString)

    return text(encoded)
}

// ==========================================
// Nginx 伪装与安全页面响应逻辑
// ==========================================
function nginxResponse(htmlContent, status = 200) {
    return new Response(htmlContent, {
        status: status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Server": "nginx",
            "Connection": "keep-alive",
            "Cache-Control": "no-cache"
        }
    })
}

function nginxPage() {
    return nginxResponse(`<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
<p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.<br/>Commercial support is available at <a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`)
}

function nginxNotFound() {
    return nginxResponse(`<html>
<head><title>404 Not Found</title></head>
<body>
<center><h1>404 Not Found</h1></center>
<hr><center>nginx</center>
</body>
</html>`, 404)
}

function loginPage(token) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔒 身份验证</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            background: #f5f7fb; height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .login-card {
            background: #ffffff; padding: 32px; border-radius: 16px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.05); width: 100%; max-width: 400px; text-align: center;
        }
        h3 { margin-bottom: 24px; font-size: 20px; color: #303133; font-weight: 600; }
        input {
            width: 100%; padding: 14px; border: 1px solid #e4e7ed; border-radius: 8px;
            font-size: 15px; outline: none; transition: all 0.25s; margin-bottom: 20px; text-align: center;
        }
        input:focus { border-color: #409eff; box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.15); }
        button {
            width: 100%; border: none; padding: 14px; border-radius: 8px; font-size: 15px;
            font-weight: 500; background: #409eff; color: white; cursor: pointer; transition: all 0.25s;
        }
        button:hover { background: #66b1ff; }
        button:active { transform: scale(0.99); }
        #msg { margin-top: 14px; font-size: 13px; color: #f56c6c; height: 20px; }
    </style>
</head>
<body>
    <div class="login-card">
        <h3>安全授权验证</h3>
        <input type="password" id="pwInput" placeholder="请输入授权密码" onkeydown="if(event.key==='Enter')login()">
        <button onclick="login()">验证并登录</button>
        <div id="msg"></div>
    </div>
    <script>
        async function login() {
            const pw = document.getElementById("pwInput").value.trim();
            const msgDiv = document.getElementById("msg");
            if(!pw) { msgDiv.innerText = "密码不能为空"; return; }
            
            msgDiv.innerText = "正在验证...";
            msgDiv.style.color = "#409eff";

            try {
                const res = await fetch("/${token}/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: pw })
                });
                const data = await res.json();
                if(data.success) {
                    msgDiv.style.color = "#67c23a";
                    msgDiv.innerText = "验证通过，正在跳转...";
                    setTimeout(() => { location.reload(); }, 500);
                } else {
                    msgDiv.style.color = "#f56c6c";
                    document.getElementById("pwInput").value = "";
                    msgDiv.innerText = data.msg || "密码错误";
                }
            } catch(e) {
                msgDiv.style.color = "#f56c6c";
                msgDiv.innerText = "网络请求失败";
            }
        }
    </script>
</body>
</html>
`
}

function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;")
}

function adminPage(config, status, update, mySubUrl) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Subscription Manager</title>
<style>
    :root {
        --primary: #409eff; --primary-hover: #66b1ff; --success: #67c23a; --success-hover: #85ce61;
        --danger: #f56c6c; --danger-hover: #f78989; --bg-body: #f5f7fb; --bg-card: #ffffff;
        --text-main: #303133; --text-regular: #606266; --text-secondary: #909399; --border-color: #e4e7ed;
        --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px; --shadow-sm: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
        --shadow-md: 0 8px 30px rgba(0, 0, 0, 0.06); --transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        max-width: 1000px; margin: 0 auto; padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: var(--bg-body); color: var(--text-main); -webkit-font-smoothing: antialiased; line-height: 1.5;
    }
    .container { background: var(--bg-card); padding: 24px; border-radius: var(--radius-lg); box-shadow: var(--shadow-md); margin-top: 10px; }
    h2 { margin-bottom: 20px; font-size: 22px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .sub-url-box {
        background: #f0f7ff; border: 1px dashed #b3d8ff; padding: 14px 16px; border-radius: var(--radius-md);
        margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .sub-url-text { font-family: monospace; font-size: 13px; color: #0066cc; word-break: break-all; user-select: all; }
    .btn-copy-main { background: #e1f0ff; color: #409eff; font-size: 12px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; border:none; cursor:pointer;}
    .btn-copy-main:hover { background: #409eff; color: white; }
    .info { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .card { background: #f8fafc; padding: 14px 18px; border-radius: var(--radius-md); flex: 1; min-width: 200px; border: 1px solid var(--border-color); transition: var(--transition); }
    .card:hover { box-shadow: var(--shadow-sm); transform: translateY(-1px); }
    .card span { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
    .card b { font-size: 20px; color: var(--text-main); font-weight: 700; word-break: break-all; }
    .form { display: flex; gap: 12px; margin: 24px 0; flex-wrap: wrap; }
    input { flex: 1; min-width: 240px; padding: 12px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 14px; outline: none; transition: var(--transition); color: var(--text-main); background: #fafafa; }
    input:focus { border-color: var(--primary); background: #fff; box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.15); }
    button { border: none; padding: 12px 20px; border-radius: var(--radius-sm); cursor: pointer; font-size: 14px; font-weight: 500; background: var(--primary); color: white; transition: var(--transition); display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    button:hover { background: var(--primary-hover); }
    button:active { transform: scale(0.98); }
    .btn-refresh { background: var(--success); }
    .btn-refresh:hover { background: var(--success-hover); }
    .btn-delete { background: var(--danger); padding: 8px 14px; font-size: 13px; border-radius: 6px; }
    .btn-delete:hover { background: var(--danger-hover); }
    .table-container { width: 100%; overflow-x: auto; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 15px; }
    table { width: 100%; border-collapse: collapse; min-width: 650px; background: #fff; }
    th { background: #f8fafc; padding: 12px 14px; text-align: left; font-weight: 600; font-size: 13px; color: var(--text-regular); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    td { padding: 14px; border-bottom: 1px solid var(--border-color); font-size: 13px; color: var(--text-regular); word-break: break-all; vertical-align: middle; }
    .url-cell { max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace; font-size: 12px; color: #7f8c8d; text-decoration: underline; text-decoration-style: dashed; }
    .badge { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .online { background: #f0f9eb; color: #67c23a; border: 1px solid #e1f3d8; }
    .offline { background: #fef0f0; color: #f56c6c; border: 1px solid #fde2e2; }
    .node { background: #ecf5ff; color: #409eff; border: 1px solid #d9ecff; }
    .empty { text-align: center; padding: 40px; color: var(--text-secondary); }
    #toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-20px); background: rgba(0, 0, 0, 0.85); color: white; padding: 10px 20px; border-radius: var(--radius-sm); font-size: 14px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 99999; opacity: 0; transition: all 0.3s ease; }
    #toast.show { display: block; opacity: 1; transform: translateX(-50%) translateY(0); }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: none; align-items: center; justify-content: center; z-index: 10000; padding: 20px; }
    .modal-card { background: white; border-radius: var(--radius-md); padding: 20px; width: 100%; max-width: 500px; box-shadow: var(--shadow-md); }
    .modal-header { font-weight: 600; margin-bottom: 12px; font-size: 16px; }
    .modal-body { background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); font-family: monospace; font-size: 13px; color: var(--text-regular); word-break: break-all; max-height: 180px; overflow-y: auto; border: 1px solid var(--border-color); user-select: all; -webkit-user-select: all; }
    .modal-footer { margin-top: 16px; display: flex; gap: 10px; justify-content: flex-end; }
    .btn-secondary { background: #e4e7ed; color: var(--text-regular); }
    .btn-secondary:hover { background: #dcdfe6; }

    @media (max-width: 680px) {
        body { padding: 10px; }
        .container { padding: 16px; }
        .sub-url-box { flex-direction: column; align-items: stretch; text-align: center; }
        .info { flex-direction: column; gap: 10px; }
        .card { width: 100%; }
        .form { flex-direction: column; align-items: stretch; gap: 10px; margin: 16px 0; }
        input, button { width: 100%; padding: 14px; font-size: 15px; }
        .url-cell { max-width: 120px; }
    }
</style>
</head>
<body>
<div class="container">
    <h2>🚀 订阅管理</h2>

    <div class="sub-url-box">
        <span class="sub-url-text" id="mySubUrlText">${mySubUrl}</span>
        <button class="btn-copy-main" onclick="copyText('${mySubUrl}')">📋 复制订阅地址</button>
    </div>

    <div class="info">
        <div class="card">
            <span>订阅数量</span>
            <b>${config.sites.length}</b>
        </div>
        <div class="card">
            <span>⏱️ 最后刷新时间 (北京时间)</span>
            <b>${escapeHtml(update)}</b>
        </div>
    </div>

    <div class="form">
        <input id="name" placeholder="名称，例如：香港01">
        <input id="url" placeholder="支持 https / vless / hy2 / tuic">
        <button onclick="add()">➕ 添加</button>
        <button class="btn-refresh" onclick="refresh()">🔄 刷新</button>
    </div>

    <div class="table-container">
        <table>
            <tr>
                <th width="15%">名称</th>
                <th width="15%">状态</th>
                <th width="10%">数量</th>
                <th width="50%">地址</th>
                <th width="10%">操作</th>
            </tr>
            ${
                config.sites.length === 0
                ? `<tr><td colspan="5" class="empty">暂无节点 data</td></tr>`
                : config.sites.map(s => {
                    const st = status.find(x => x.name.trim() === s.name.trim())
                    const direct = isNode(s.url)
                    let badge;

                    if(direct){
                        badge = `<span class="badge node">📌 节点</span>`
                    } else if(st?.ok){
                        badge = `<span class="badge online">🟢 在线</span>`
                    } else {
                        badge = `<span class="badge offline">🔴 离线</span>`
                    }

                    const base64Url = btoa(unescape(encodeURIComponent(s.url)));

                    return `
                    <tr>
                        <td><strong>${escapeHtml(s.name)}</strong></td>
                        <td>${badge}</td>
                        <td>${st?.count || (direct?1:0)}</td>
                        <td class="url-cell" 
                            title="${escapeHtml(s.url)}" 
                            style="cursor: pointer;" 
                            onclick="showUrl('${escapeHtml(s.name)}', '${base64Url}')">
                            ${escapeHtml(s.url)}
                        </td>
                        <td>
                            <button class="btn-delete" onclick="delNode('${base64Url}')">删除</button>
                        </td>
                    </tr>
                    `
                }).join("")
            }
        </table>
    </div>
</div>

<div id="urlModal" class="modal-overlay" onclick="closeModal()">
    <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header" id="modalTitle">完整地址</div>
        <div class="modal-body" id="modalContent"></div>
        <div class="modal-footer">
            <button class="btn-secondary" onclick="closeModal()">关闭</button>
            <button onclick="copyUrl()">📋 复制链接</button>
        </div>
    </div>
</div>

<div id="toast"></div>

<script>
    let globalRawUrl = ""; 

    function toast(msg){
        const t = document.getElementById("toast")
        t.innerHTML = msg
        t.style.display = "block"
        setTimeout(() => { t.classList.add("show") }, 10)
        setTimeout(()=>{
            t.classList.remove("show")
            setTimeout(() => { t.style.display = "none" }, 300)
        }, 2000)
    }

    function decodeB64(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    function showUrl(name, b64Url) {
        try {
            const realUrl = decodeB64(b64Url);
            globalRawUrl = realUrl;
            document.getElementById("modalTitle").innerText = "🔗 " + name + " 的完整地址";
            document.getElementById("modalContent").innerText = realUrl;
            document.getElementById("urlModal").style.display = "flex";
        } catch(e) {
            console.error(e);
            toast("解析失败");
        }
    }

    function closeModal() {
        document.getElementById("urlModal").style.display = "none";
    }

    function copyText(textToCopy) {
        if (!textToCopy) return;
        let success = false;
        try {
            const textArea = document.createElement("textarea");
            textArea.value = textToCopy;
            textArea.style.position = "fixed";
            textArea.style.top = "0"; textArea.style.left = "0";
            textArea.style.width = "2em"; textArea.style.height = "2em";
            textArea.style.padding = "0"; textArea.style.border = "none";
            textArea.style.outline = "none"; textArea.style.boxShadow = "none";
            textArea.style.background = "transparent";
            
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            textArea.setSelectionRange(0, 99999); 
            
            success = document.execCommand("copy");
            document.body.removeChild(textArea);
        } catch (err) {
            success = false;
        }

        if (!success && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                toast("⚡ 复制成功！");
            }).catch(() => {
                toast("❌ 复制失败");
            });
            return;
        }

        if (success) {
            toast("⚡ 复制成功！");
        } else {
            toast("❌ 复制失败");
        }
    }

    function copyUrl() {
        copyText(globalRawUrl);
        closeModal();
    }

    async function add(){
        const name = document.getElementById("name").value.trim()
        const url = document.getElementById("url").value.trim()

        if(!name || !url){
            toast("请输入完整信息")
            return
        }

        const res = await fetch(
            location.pathname.replace("/admin", "/api/add"),
            {
                method:"POST",
                headers:{ "content-type": "application/json" },
                body: JSON.stringify({ name, url })
            }
        )

        const data = await res.json()
        if(data.success){
            toast("添加成功")
            setTimeout(()=>{ location.reload() }, 800)
        }
    }

    async function delNode(b64Url){
        if(!confirm("确定删除这个节点吗？")) return
        const realUrl = decodeB64(b64Url);

        await fetch(
            location.pathname.replace("/admin", "/api/delete"),
            {
                method:"POST",
                headers:{ "content-type": "application/json" },
                body: JSON.stringify({ url: realUrl })
            }
        )
        toast("删除成功")
        setTimeout(()=>{ location.reload() }, 800)
    }

    async function refresh(){
        toast("正在刷新...")
        await fetch(
            location.pathname.replace("/admin", "/api/refresh"),
            {
                method:"POST",
                headers:{ "content-type": "application/json" }
            }
        )
        toast("刷新完成")
        setTimeout(()=>{ location.reload() }, 800)
    }
</script>
</body>
</html>
`
}

function text(v = "") {
    return new Response(v, { headers: { "content-type": "text/plain; charset=utf-8", "server": "nginx" } })
}

function html(v = "") {
    return new Response(v, { headers: { "content-type": "text/html; charset=utf-8", "server": "nginx" } })
}

function json(v = {}) {
    return new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "server": "nginx" } })
}
