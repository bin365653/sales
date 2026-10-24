"use client";

import { useState } from "react";

// 退出登录：调用登出 API 撤销服务端会话后回登录页。

export function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? "退出中…" : "退出登录"}
    </button>
  );
}
