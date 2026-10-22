#!/usr/bin/env bash
# 启动脚本：仅在 252 服务器启动现有业务后端；不构建或新增前端。
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CAMERA4G_252_ENV:-/etc/camera4g/private/platform.env}"
[[ -r "$ENV_FILE" ]] || { echo '缺少 252 私有环境配置 CAMERA4G_252_ENV' >&2; exit 1; }
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
: "${NODE_BINARY:?指定 Node 24 可执行文件绝对路径}"
: "${BASE_URL:?指定浏览器实际访问的 HTTPS 地址}"
: "${PPE_CONFIG_FILE:?缺少 PPE_CONFIG_FILE}"
[[ "$NODE_BINARY" = /* && -x "$NODE_BINARY" ]] || { echo 'NODE_BINARY 必须是可执行文件绝对路径' >&2; exit 1; }
[[ "$BASE_URL" == https://* ]] || { echo 'BASE_URL 必须是对外 HTTPS 地址' >&2; exit 1; }
cd "$REPO_ROOT"
# Fail before opening the business port if GPU URLs or credentials are missing.
"$NODE_BINARY" --input-type=module -e '
import { privateConfig, upstreamBase } from "./server/camera4g-upstream.mjs";
const p = privateConfig({}, "PPE_CONFIG_FILE");
for (const value of [p?.apiBaseUrl, p?.previewBaseUrl]) {
  const url = upstreamBase(value);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("252 requires external GPU HTTPS URLs");
}
if (![p.cameraToken, p.previewPassword].every(v => typeof v === "string" && v.length >= 32 && !v.startsWith("REPLACE_"))) throw Error("Configure private GPU credentials");
if (process.env.CAMERA4G_ATTENDANCE_CONFIG_FILE) {
  const a = privateConfig({}, "CAMERA4G_ATTENDANCE_CONFIG_FILE");
  const url = upstreamBase(a?.baseUrl);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("252 requires external GPU attendance HTTPS URL");
  if (typeof a.token !== "string" || a.token.length < 32 || a.token.startsWith("REPLACE_")) throw Error("Configure private attendance credentials");
}
'
export NODE_ENV=production
exec "$NODE_BINARY" server/index.mjs
