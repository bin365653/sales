"use client";

import { useState } from "react";

// 电话一键复制（工作台「建议优先联系」卡，UIUX P2）：
// 系统绝不自动外呼——拨打始终由用户手动进行（PRD §5.5 边界）。

export function CopyPhoneButton({ phone }: { phone: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(phone);
      setState("ok");
    } catch {
      setState("fail");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  if (!phone) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={`tel:${phone}`}
        className="text-sm text-gray-700 hover:text-blue-700 md:pointer-events-none md:text-gray-700"
        title="手机端点击拨打（系统不会自动外呼）"
      >
        {phone}
      </a>
      <button
        type="button"
        onClick={copy}
        aria-label={`复制电话 ${phone}`}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 transition hover:bg-gray-50"
      >
        {state === "ok" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
      </button>
    </span>
  );
}
