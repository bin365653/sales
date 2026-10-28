// E2E 全局准备（T18）：应用就绪后，通过真实 API 启用一条指向本地 Mock
// Provider 的模型配置——密钥经应用侧 AES-256-GCM 加密落库，与生产同链路。
// （不直插数据库：密文格式属应用内部实现，E2E 只走公共契约。）

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_MOCK_AI_URL = "http://127.0.0.1:4599/v1";
const DEFAULT_ADMIN_PASSWORD = "e2e-admin-2026";

export default async function globalSetup(): Promise<void> {
  const base = process.env.E2E_BASE_URL ?? DEFAULT_BASE_URL;
  const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: adminPassword }),
  });
  if (!login.ok) {
    throw new Error(`E2E 全局准备失败：管理员登录返回 ${login.status}`);
  }
  const cookie = (login.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; "));

  const createConfig = await fetch(`${base}/api/settings/model-configs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
    body: JSON.stringify({
      provider: "openai_compatible",
      baseUrl: process.env.E2E_MOCK_AI_URL ?? DEFAULT_MOCK_AI_URL,
      modelName: "e2e-mock",
      apiKey: "e2e-mock-key-not-a-real-secret",
      isActive: true,
    }),
  });
  if (!createConfig.ok) {
    throw new Error(
      `E2E 全局准备失败：创建模型配置返回 ${createConfig.status} ` +
        (await createConfig.text()),
    );
  }
  console.log("[e2e-global] Mock AI 模型配置已启用");
}
