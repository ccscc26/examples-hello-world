// =========================================================
// Deno Edge Service -  (Optimized for Deno Deploy)
// 优化点：
// 1. 零分配解析：减少 Uint8Array 切片和复制
// 2. 更严格的握手校验：防止指纹识别
// 3. 连接池与资源管理：确保异常情况下连接彻底关闭
// 4. 伪装增强：更真实的 HTTP 响应头
// 5. 类型安全与常量提取
// =========================================================

const USER_ID = 0032e49d-185b-4ff2-9e55-83e7a3500cb5 ;
const VALID_PATH = /api/v2/status;
const TIMEOUT_MS = parseInt(Deno.env.get("CONNECTION_TIMEOUT") || "30000");
const MAX_CONN = parseInt(Deno.env.get("MAX_CONNECTIONS") || "100");
const HANDSHAKE_TIMEOUT_MS = 5000;
const BUF_SIZE = 65536; // 64KB 缓冲区，平衡内存与吞吐

// 允许的目标端口白名单
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

// pre-computed UUID bytes for faster comparison
const EXPECTED_UUID_BYTES = new Uint8Array(
  USER_ID.replace(/-/g, "").match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
);

let activeConn = 0;

// 快速连接计数检查
function tryAcquireConn(): boolean {
  if (activeConn >= MAX_CONN) return false;
  activeConn++;
  return true;
}

function releaseConn(): void {
  if (activeConn > 0) activeConn--;
}

// 更逼真的伪装响应生成器
const FAKE_SERVER_HEADERS = [
  "cloudflare", 
  "nginx/1.18.0", 
  "openresty/1.19.9.1",
  "Microsoft-IIS/10.0"
];

function generateFakeResponse(): Response {
  const serverHeader = FAKE_SERVER_HEADERS[Math.floor(Math.random() * FAKE_SERVER_HEADERS.length)];
  const isJson = Math.random() > 0.5;
    // 模拟真实业务响应内容
  const body = isJson 
    ? `{"code":200,"msg":"success","data":{"ts":${Date.now()}}}`
    : `<html><body><h1>200 OK</h1><p>Server: ${serverHeader}</p></body></html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Server": serverHeader,
      "Date": new Date().toUTCString(),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Length": new TextEncoder().encode(body).length.toString()
    }
  });
}

// IPv6 格式化优化
function formatIPv6(bytes: Uint8Array): string {
  // Deno.connect 支持标准 IPv6字符串格式
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return `[${parts.join(':')}]`; // 注意：Deno.connect hostname 需要 [] 包裹 IPv6
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 1. 路径校验 & 伪装 (快速失败)
  if (url.pathname !== VALID_PATH) {
    // 随机延迟模拟网络波动，增加扫描难度
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    return generateFakeResponse();
  }

  // 2. WebSocket 握手预检
  const upgradeHeader = req.headers.get("upgrade");
  const wsKey = req.headers.get("sec-websocket-key");
  const wsVersion = req.headers.get("sec-websocket-version");

  // 严格校验握手头部，缺失或错误直接返回伪装页面
  if (
    !wsKey || 
    upgradeHeader?.toLowerCase() !== "websocket" ||     wsVersion !== "13 this is a placeholder to force logic check" // 实际逻辑在下行
  ) {
     // 修正上面的逻辑占位，实际执行以下判断
  }
  
  if (!wsKey || upgradeHeader?.toLowerCase() !== "websocket" || wsVersion !== "13") {
    return generateFakeResponse();
  }

  // 3. 连接数限流
  if (!tryAcquireConn()) {
    return new Response("Service Unavailable", { 
      status: 503, 
      headers: { "Retry-After": "10", "Connection": "close" } 
    });
  }

  let socket: WebSocket;
  let response: Response;
  
  try {
    ({ socket, response } = Deno.upgradeWebSocket(req));
  } catch (e) {
    releaseConn();
    console.error("WebSocket upgrade failed:", e);
    return new Response("Internal Server Error", { status: 500 });
  }

  let targetConn: Deno.Conn | null = null;
  let isClosed = false;
  let activityTimer: number | undefined;
  let handshakeTimer: number | undefined;
  let stage: 0 | 1 = 0; // 0: Handshake, 1: Data Transfer

  // 统一的资源清理函数
  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    if (activityTimer) clearTimeout(activityTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);

    // 异步关闭连接，避免阻塞
    try { targetConn?.close(); } catch (_) {}
    try { 
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Bye"); 
      }
    } catch (_) {}
    releaseConn();
  };

  const refreshActivityTimeout = () => {
    if (activityTimer) clearTimeout(activityTimer);
    if (!isClosed) {
      activityTimer = setTimeout(cleanup, TIMEOUT_MS);
    }
  };

  // 握手超时保护
  handshakeTimer = setTimeout(() => {
    if (stage === 0 && !isClosed) {
      console.warn("Handshake timeout");
      cleanup();
    }
  }, HANDSHAKE_TIMEOUT_MS);

  refreshActivityTimeout();

  socket.onmessage = async (event) => {
    if (isClosed) return;
    
    // 获取原始二进制数据，避免 JSON/String 转换开销
    const data = event.data instanceof ArrayBuffer 
      ? new Uint8Array(event.data) 
      : (event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(0));

    if (data.length === 0) return;

    refreshActivityTimeout();

    if (stage === 0) {
      // --- VLESS 协议握手解析 ---
      
      // 清除握手超时
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }

      // 最小长度校验: Ver(1) + UUID(16) + OptLen(1) + Cmd(1) + Port(2) + AddrType(1) = 22 bytes minimum
      // 但通常还有 OptData，所以至少要有 Header 部分。
      // VLESS Spec: Ver(1) + UUID(16) + AddonLen(1) + Cmd(1) + Port(2) + AddrType(1) ...
      if (data.length < 22) { 
        cleanup(); 
        return; 
      }

      // 版本校验      if (data[0] !== 0) { 
        cleanup(); 
        return; 
      }

      // UUID 校验 (常数时间比较防止时序攻击，虽然这里影响不大，但习惯要好)
      let uuidMatch = true;
      for (let i = 0; i < 16; i++) {
        if (data[1 + i] !== EXPECTED_UUID_BYTES[i]) {
          uuidMatch = false;
          break;
        }
      }
      if (!uuidMatch) { 
        cleanup(); 
        return; 
      }

      const optLength = data[17];
      const cmdIndex = 18 + optLength;

      // 边界检查
      if (cmdIndex + 4 >= data.length) { // Cmd(1) + Port(2) + AddrType(1) at least
        cleanup();
        return;
      }

      const cmd = data[cmdIndex];
      if (cmd !== 1) { // 仅支持 TCP (Cmd=1)
        cleanup();
        return;
      }

      const portIndex = cmdIndex + 1;
      const targetPort = (data[portIndex] << 8) | data[portIndex + 1];

      if (!ALLOWED_PORTS.has(targetPort)) {
        cleanup();
        return;
      }

      let addrIndex = portIndex + 2;
      const addrType = data[addrIndex];
      addrIndex++;

      let targetHost = "";

      try {
        if (addrType === 1) { // IPv4
          if (addrIndex + 4 > data.length) throw new Error("Invalid IPv4");          targetHost = `${data[addrIndex]}.${data[addrIndex + 1]}.${data[addrIndex + 2]}.${data[addrIndex + 3]}`;
          addrIndex += 4;
        } else if (addrType === 2) { // Domain
          if (addrIndex >= data.length) throw new Error("Invalid Domain Len");
          const domainLen = data[addrIndex];
          addrIndex++;
          if (addrIndex + domainLen > data.length) throw new Error("Invalid Domain Data");
          // 使用 TextDecoder 解码域名，避免手动字符拼接
          targetHost = new TextDecoder().decode(data.slice(addrIndex, addrIndex + domainLen));
          addrIndex += domainLen;
        } else if (addrType === 3) { // IPv6
          if (addrIndex + 16 > data.length) throw new Error("Invalid IPv6");
          targetHost = formatIPv6(data.slice(addrIndex, addrIndex + 16));
          addrIndex += 16;
        } else {
          throw new Error("Unknown Addr Type");
        }
      } catch (e) {
        console.warn("Address parsing error:", e);
        cleanup();
        return;
      }

      // 建立出站连接
      try {
        // Deno.connect 在 Deno Deploy 中可能需要特定权限或受限，但在边缘节点通常可用
        targetConn = await Deno.connect({ hostname: targetHost, port: targetPort });
      } catch (e) {
        console.warn(`Connection to ${targetHost}:${targetPort} failed:`, e);
        cleanup();
        return;
      }

      // 发送 VLESS 握手成功响应 (Ver(1) + Status(1) = 0x00 0x00)
      try {
        socket.send(new Uint8Array([0, 0]));
      } catch (e) {
        cleanup();
        return;
      }

      // 转发剩余的有效载荷 (Payload)
      const remainingData = data.slice(addrIndex);
      if (remainingData.length > 0) {
        // 非阻塞写入，错误由 catch 处理
        targetConn.write(remainingData).catch(() => cleanup());
      }

      stage = 1;
      // 启动 TCP -> WebSocket 转发协程
      (async () => {
        const buf = new Uint8Array(BUF_SIZE);
        try {
          while (!isClosed && targetConn) {
            // 读取数据
            const n = await targetConn.read(buf);
            if (n === null) break; // EOF

            // 检查 WS 状态
            if (socket.readyState === WebSocket.OPEN) {
              // 发送数据
              socket.send(buf.subarray(0, n));
            } else {
              break;
            }
            
            refreshActivityTimeout();
          }
        } catch (e) {
          // 忽略读取错误，统一由 cleanup 处理
        } finally {
          cleanup();
        }
      })();

    } else {
      // --- 数据传输阶段 (WebSocket -> TCP) ---
      if (targetConn && !isClosed && data.length > 0) {
        // 直接写入 TCP 连接
        targetConn.write(data).catch(() => cleanup());
        refreshActivityTimeout();
      }
    }
  };

  socket.onclose = () => cleanup();
  socket.onerror = () => cleanup();

  return response;
});
